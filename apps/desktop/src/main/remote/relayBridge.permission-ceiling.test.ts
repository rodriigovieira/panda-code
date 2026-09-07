import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SessionStartRequest } from "../../shared/ipc";
import { commandKey, COMMAND_DOMAIN } from "./commandAuth";
import { encryptJson } from "./crypto";
import { createRelayBridge } from "./relayBridge";

function request(overrides: Partial<SessionStartRequest> = {}): SessionStartRequest {
  return {
    id: "section",
    cwd: "/tmp/example",
    command: "claude",
    runtime: "claude",
    permissionMode: "default",
    executionMode: "stream-json",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function authenticatedCommand(key: Uint8Array, type: "input" | "queue" | "approve" | "deny", payload: unknown) {
  const routing = { type, sessionId: "section", mobileId: "phone" };
  return {
    ...routing,
    payloadCipher: encryptJson({
      v: 2,
      domain: COMMAND_DOMAIN,
      id: randomUUID(),
      deviceId: "device",
      ...routing,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload,
    }, commandKey(key)),
  };
}

function bridgeFor(startRequest: SessionStartRequest, allowRemoteFullAccess = false) {
  const sendInput = vi.fn(async () => ({ ok: true }));
  const answerApproval = vi.fn(() => ({ ok: true }));
  const bridge = createRelayBridge({
    allowRemoteFullAccess: () => allowRemoteFullAccess,
    log: () => undefined,
    sessionService: { getRequest: () => startRequest, sendInput, answerApproval },
  } as unknown as Parameters<typeof createRelayBridge>[0]);
  const key = new Uint8Array(32).fill(3);
  const internals = bridge as unknown as { credentials: unknown; dispatchCommand: (command: unknown) => unknown };
  internals.credentials = { deviceId: "device", key };
  return { internals, key, sendInput, answerApproval };
}

it.each([
  "claude --dangerously-skip-permissions",
  "claude --allow-dangerously-skip-permissions",
  "claude --permission-mode=bypassPermissions",
  "claude --permission-mode",
])("rejects authenticated phone input when %s overrides a safe saved mode", (command) => {
  const { internals, key, sendInput } = bridgeFor(request({ command }));
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "input", { data: "synthetic prompt" })))
    .toThrow(/blocked by the Mac/);
  expect(sendInput).not.toHaveBeenCalled();
});

it("rejects the ambiguous quoted-safe/saved-bypass combination for a legacy request", () => {
  const { internals, key, sendInput } = bridgeFor(request({
    command: 'claude "--permission-mode" default',
    permissionMode: "bypassPermissions",
  }));
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "input", { data: "synthetic prompt" })))
    .toThrow(/blocked by the Mac/);
  expect(sendInput).not.toHaveBeenCalled();
});

it("allows an explicit full-access Claude launch only while the Mac opt-in is enabled", async () => {
  const { internals, key, sendInput } = bridgeFor(request({ command: "claude --dangerously-skip-permissions" }), true);
  await internals.dispatchCommand(authenticatedCommand(key, "input", { data: "synthetic prompt" }));
  expect(sendInput).toHaveBeenCalledOnce();
});

it("fails closed when an existing Codex session has no resolved sandbox", () => {
  const { internals, key, sendInput } = bridgeFor(request({ runtime: "codex", command: "codex", permissionMode: undefined }));
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "input", { data: "synthetic prompt" })))
    .toThrow(/blocked by the Mac/);
  expect(sendInput).not.toHaveBeenCalled();
});

it("rechecks authority before accepting queued prompts and phone approvals", () => {
  const { internals, key, sendInput, answerApproval } = bridgeFor(request({ command: "claude --permission-mode bypassPermissions" }));
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "queue", { action: "add", id: "q1", data: "later" })))
    .toThrow(/blocked by the Mac/);
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "approve", { optionId: "accept" })))
    .toThrow(/blocked by the Mac/);
  expect(sendInput).not.toHaveBeenCalled();
  expect(answerApproval).not.toHaveBeenCalled();
});

it("allows an authenticated phone denial even when the session is full-access", () => {
  const { internals, key, answerApproval } = bridgeFor(
    request({ command: "claude --dangerously-skip-permissions" }),
  );
  expect(internals.dispatchCommand(authenticatedCommand(key, "deny", { promptId: "prompt-1" })))
    .toEqual({ succeeded: true, payload: { message: "Denied." } });
  expect(answerApproval).toHaveBeenCalledExactlyOnceWith({
    id: "section",
    promptId: "prompt-1",
    optionId: "decline",
    text: undefined,
  });
});

it("does not let a deny envelope smuggle a non-decline answer without Mac opt-in", () => {
  const { internals, key, answerApproval } = bridgeFor(
    request({ command: "claude --dangerously-skip-permissions" }),
  );
  expect(() => internals.dispatchCommand(authenticatedCommand(key, "deny", {
    promptId: "prompt-1",
    optionId: "accept",
  }))).toThrow(/Phone approvals are disabled/);
  expect(answerApproval).not.toHaveBeenCalled();
});
