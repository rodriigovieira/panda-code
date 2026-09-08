import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configureTranscriptIndexForTest, handleTranscriptIndexRequest } from "./transcript-index-worker";
import type { TranscriptIndexMetadata, TranscriptIndexPage, TranscriptIndexSearchHit } from "../shared/transcript-index";

const root = mkdtempSync(join(tmpdir(), "panda-transcript-index-test-"));
const source = join(root, "claude.jsonl");
const key = "claude:fixture:one";
const codexSource = join(root, "codex.jsonl");
const codexKey = "codex:fixture:one";
const modernCodexSource = join(root, "codex-modern.jsonl");
const modernCodexKey = "codex:fixture:modern";

afterAll(() => rmSync(root, { recursive: true, force: true }));

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("persistent transcript index", () => {
  it("pages by byte cursor, indexes appends once, persists metadata, and searches off-main data", async () => {
    const rows: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      rows.push(line({ type: "user", uuid: `u${index}`, message: { content: `question ${index}` } }));
      rows.push(
        line({
          type: "assistant",
          uuid: `a${index}`,
          message: {
            id: `m${index}`,
            content: [{ type: "text", text: `answer ${index}` }],
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }),
      );
    }
    writeFileSync(source, `${rows.join("\n")}\n`);
    configureTranscriptIndexForTest({ directory: join(root, "index"), home: root });
    await handleTranscriptIndexRequest({
      id: 1,
      type: "register",
      registrations: [{ key, runtime: "claude", path: source }],
    });

    const latest = (await handleTranscriptIndexRequest({ id: 2, type: "page", key, maxRecords: 4 })) as TranscriptIndexPage;
    expect(latest.lines).toHaveLength(4);
    expect(latest.hasEarlier).toBe(true);
    const older = (await handleTranscriptIndexRequest({
      id: 3,
      type: "page",
      key,
      beforeOffset: latest.beforeOffset,
      maxRecords: 4,
    })) as TranscriptIndexPage;
    expect(older.lines).toHaveLength(4);
    expect(Math.max(...older.lines.map((entry) => entry.offset))).toBeLessThan(latest.beforeOffset!);

    const before = (await handleTranscriptIndexRequest({ id: 4, type: "metadata", key })) as TranscriptIndexMetadata;
    appendFileSync(source, `${line({ type: "user", uuid: "u6", message: { content: "needle appended incrementally" } })}\n`);
    const after = (await handleTranscriptIndexRequest({ id: 5, type: "refresh", key })) as TranscriptIndexMetadata;
    expect(after.indexedBytes).toBeGreaterThan(before.indexedBytes);
    expect(after.tokenUsage.totalTokens).toBe(72);
    expect(after.title).toBe("question 0");

    const hits = (await handleTranscriptIndexRequest({
      id: 6,
      type: "search",
      query: "needle",
      documents: [{ key, id: "section", title: "Stored title", workspaceName: "Fixture" }],
      limit: 10,
    })) as TranscriptIndexSearchHit[];
    expect(hits.map((hit) => hit.id)).toEqual(["section"]);

    configureTranscriptIndexForTest({ directory: join(root, "index"), home: root });
    await handleTranscriptIndexRequest({
      id: 7,
      type: "register",
      registrations: [{ key, runtime: "claude", path: source }],
    });
    const persisted = (await handleTranscriptIndexRequest({ id: 8, type: "metadata", key })) as TranscriptIndexMetadata;
    expect(persisted.indexedBytes).toBe(after.indexedBytes);
    expect(persisted.tokenUsage.totalTokens).toBe(72);
  });

  it("persists the active Codex model on each indexed assistant message", async () => {
    writeFileSync(
      codexSource,
      `${[
        line({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
        line({ type: "event_msg", payload: { type: "user_message", message: "first" } }),
        line({ type: "event_msg", payload: { type: "agent_message", message: "one" } }),
        line({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
        line({ type: "event_msg", payload: { type: "user_message", message: "second" } }),
        line({ type: "event_msg", payload: { type: "agent_message", message: "two" } }),
      ].join("\n")}\n`,
    );
    await handleTranscriptIndexRequest({
      id: 9,
      type: "register",
      registrations: [{ key: codexKey, runtime: "codex", path: codexSource }],
    });

    const page = (await handleTranscriptIndexRequest({ id: 10, type: "page", key: codexKey, maxRecords: 10 })) as TranscriptIndexPage;
    const replies = page.lines.filter((entry) => JSON.parse(entry.text).payload?.type === "agent_message");
    expect(replies.map((entry) => entry.model)).toEqual(["gpt-5.6-sol", "gpt-6-astra"]);
  });

  it("indexes current Codex input/output message records as readable conversation", async () => {
    writeFileSync(
      modernCodexSource,
      `${[
        line({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
        line({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "internal" }] } }),
        line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible question" }] } }),
        line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer" }] } }),
        line({ timestamp: "2026-09-08T08:22:19.094Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 954765 } }),
      ].join("\n")}\n`,
    );
    await handleTranscriptIndexRequest({
      id: 11,
      type: "register",
      registrations: [{ key: modernCodexKey, runtime: "codex", path: modernCodexSource }],
    });

    const page = (await handleTranscriptIndexRequest({
      id: 12,
      type: "page",
      key: modernCodexKey,
      maxRecords: 10,
    })) as TranscriptIndexPage;
    const messages = page.lines.filter((entry) => JSON.parse(entry.text).payload?.type === "message");
    expect(messages.map((entry) => JSON.parse(entry.text).payload.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)?.model).toBe("gpt-5.6-sol");
    expect(page.lines.map((entry) => JSON.parse(entry.text).payload?.type)).toContain("task_complete");
    expect(page.metadata.title).toBe("visible question");
  });

  it("derives a Codex fallback title from the real request, not injected context", async () => {
    const injectedSource = join(root, "codex-injected.jsonl");
    const injectedKey = "codex:fixture:injected";
    const submitted = [
      "<recommended_plugins>Here is a list of plugins that are available but not installed.</recommended_plugins>",
      "# AGENTS.md instructions for /Users/example/project\n\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS>",
      "<environment_context><cwd>/Users/example/project</cwd></environment_context>",
      "<developer_instructions>Internal Panda instructions</developer_instructions>\n\nFix robust Codex section titles",
    ];
    writeFileSync(
      injectedSource,
      `${line({
        type: "response_item",
        payload: { type: "message", role: "user", content: submitted.map((text) => ({ type: "input_text", text })) },
      })}\n`,
    );
    await handleTranscriptIndexRequest({
      id: 13,
      type: "register",
      registrations: [{ key: injectedKey, runtime: "codex", path: injectedSource }],
    });

    const metadata = (await handleTranscriptIndexRequest({ id: 14, type: "metadata", key: injectedKey })) as TranscriptIndexMetadata;
    expect(metadata.title).toBe("Fix robust Codex section titles");
  });

  it("uses a peer-created section's task instead of its relationship preamble", async () => {
    const peerSource = join(root, "codex-peer.jsonl");
    const peerKey = "codex:fixture:peer";
    const prompt = [
      '[This section is a SUB-THREAD of the Panda Code section "Parent" (id `parent`), working in this same workspace.',
      "Treat the task below as the operator's own request and get on with it.]",
      "",
      "Audit the checkout flow",
    ].join("\n");
    writeFileSync(
      peerSource,
      `${line({ type: "event_msg", payload: { type: "user_message", message: prompt } })}\n`,
    );
    await handleTranscriptIndexRequest({
      id: 15,
      type: "register",
      registrations: [{ key: peerKey, runtime: "codex", path: peerSource }],
    });

    const metadata = (await handleTranscriptIndexRequest({ id: 16, type: "metadata", key: peerKey })) as TranscriptIndexMetadata;
    expect(metadata.title).toBe("Audit the checkout flow");
  });

  it("uses the last handoff request instead of naming a resumed section Continue", async () => {
    const handoffSource = join(root, "codex-handoff.jsonl");
    const handoffKey = "codex:fixture:handoff";
    const prompt = [
      '<runtime-handoff from="Claude" to="Codex">',
      "You are continuing a Panda Code section.",
      "### User @ 2026-09-01T00:00:00Z",
      "Audit the shared design system and recommend next steps",
      "### Assistant @ 2026-09-01T00:01:00Z",
      "I will inspect it.",
      "</runtime-handoff>",
      "",
      "Continue",
    ].join("\n");
    writeFileSync(
      handoffSource,
      `${line({ type: "event_msg", payload: { type: "user_message", message: prompt } })}\n`,
    );
    await handleTranscriptIndexRequest({
      id: 17,
      type: "register",
      registrations: [{ key: handoffKey, runtime: "codex", path: handoffSource }],
    });

    const metadata = (await handleTranscriptIndexRequest({ id: 18, type: "metadata", key: handoffKey })) as TranscriptIndexMetadata;
    expect(metadata.title).toBe("Audit the shared design system and recommend next steps");
    expect(metadata.titleSource).toBe("handoff");
  });
});
