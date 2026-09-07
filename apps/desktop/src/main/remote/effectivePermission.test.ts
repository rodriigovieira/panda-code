import { describe, expect, it } from "vitest";
import {
  effectiveClaudePermissionFromArgs,
  effectiveRemotePermission,
  resolveClaudeLaunchPermission,
  tokenizeLaunchCommand,
} from "./effectivePermission";

describe("Claude launch permission resolution", () => {
  it("recognizes a separately quoted permission flag exactly as the launcher does", () => {
    expect(tokenizeLaunchCommand('claude "--permission-mode" default')).toEqual([
      "claude", "--permission-mode", "default",
    ]);
    expect(resolveClaudeLaunchPermission('claude "--permission-mode" default', "bypassPermissions"))
      .toEqual({
        commandHasPermissionOverride: true,
        effectivePermissionMode: "default",
        appendedArgs: [],
      });
  });

  it("recognizes an escaped flag exactly as the launcher does", () => {
    expect(resolveClaudeLaunchPermission("claude \\--permission-mode acceptEdits", "bypassPermissions"))
      .toMatchObject({
        commandHasPermissionOverride: true,
        effectivePermissionMode: "acceptEdits",
        appendedArgs: [],
      });
  });

  it("does not mistake a quoted argument containing spaces for a flag", () => {
    expect(tokenizeLaunchCommand('claude "--permission-mode default"')).toEqual([
      "claude", "--permission-mode default",
    ]);
    expect(resolveClaudeLaunchPermission('claude "--permission-mode default"', "bypassPermissions"))
      .toMatchObject({
        commandHasPermissionOverride: false,
        effectivePermissionMode: "bypassPermissions",
        appendedArgs: ["--dangerously-skip-permissions"],
      });
  });

  it("fails closed for a malformed permission value while suppressing saved args", () => {
    expect(resolveClaudeLaunchPermission("claude --permission-mode --model opus", "default"))
      .toEqual({
        commandHasPermissionOverride: true,
        effectivePermissionMode: undefined,
        appendedArgs: [],
      });
  });

  it("still detects a bypass token after a malformed value flag", () => {
    expect(resolveClaudeLaunchPermission(
      "claude --permission-mode --dangerously-skip-permissions",
      "default",
    )).toMatchObject({
      commandHasPermissionOverride: true,
      effectivePermissionMode: "bypassPermissions",
      appendedArgs: [],
    });
    expect(resolveClaudeLaunchPermission(
      "claude --model --dangerously-skip-permissions",
      "default",
    ).effectivePermissionMode).toBe("bypassPermissions");
  });

  it("does not treat a bypass-looking value inside another flag as authority", () => {
    expect(resolveClaudeLaunchPermission(
      "claude --model=--dangerously-skip-permissions",
      "default",
    )).toMatchObject({
      commandHasPermissionOverride: false,
      effectivePermissionMode: "default",
      appendedArgs: ["--permission-mode", "default"],
    });
  });

  it("derives recorded authority from the final argv, including old double-appends", () => {
    expect(effectiveClaudePermissionFromArgs([
      "--permission-mode", "default", "--dangerously-skip-permissions",
    ])).toBe("bypassPermissions");
  });

  it("keeps saved bypass authority for legacy requests without a trustworthy launch record", () => {
    expect(effectiveRemotePermission({
      id: "legacy",
      cwd: "/repo",
      command: 'claude "--permission-mode" default',
      runtime: "claude",
      permissionMode: "bypassPermissions",
      executionMode: "stream-json",
      cols: 80,
      rows: 24,
    })).toEqual({ runtime: "claude", permissionMode: "bypassPermissions" });
  });

});
