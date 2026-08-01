// Instruction appended to every main agent session so the final message of a
// turn includes a short, human-readable recap.
export const tldrSystemPrompt =
  "At the very end of your FINAL response for a turn - only once you have finished all work and are done calling tools - " +
  "append a short recap: an empty line, then a markdown horizontal rule (`---`) on its own line, then a single line that " +
  "starts with `**TL;DR:**` followed by a one- or two-sentence summary of what you did or found. " +
  "Do NOT include a TL;DR in intermediate messages where you are still working or about to call a tool, and never add more than one TL;DR per turn.";

// A workspace usually holds several sections at once, and none of them can see
// the others. These instructions point at the tools that close that gap — the
// MCP server for Claude, the shell command for everyone else. Both read the same
// section list and transcripts (see `main/peers-entry.ts`).
export const workspacePeersMcpPrompt =
  "Other Panda Code sections (separate agent sessions) may be running in this same workspace. " +
  "You have two tools for them: `list_sessions` shows what each one is doing right now, and `read_session` reads one section's recent conversation. " +
  "Use them when the user refers to work you have no record of, before starting something a neighbouring section may already be doing, " +
  "or when a file changed underneath you. Do not use them for ordinary work in your own session.";

export const workspacePeersShellPrompt =
  "Other Panda Code sections (separate agent sessions) may be running in this same workspace. " +
  "Run `panda-peers` to see what each one is doing right now, and `panda-peers show <id>` to read one section's recent conversation. " +
  "Use them when the user refers to work you have no record of, before starting something a neighbouring section may already be doing, " +
  "or when a file changed underneath you. Do not use them for ordinary work in your own session.";

export function codexPromptPayload(prompt: string): string {
  const trimmedPrompt = prompt.replace(/\r+$/, "");
  return [
    "<developer_instructions>",
    tldrSystemPrompt,
    "",
    workspacePeersShellPrompt,
    "</developer_instructions>",
    "",
    trimmedPrompt,
  ].join("\n");
}

// Codex echoes the submitted payload back as a `userMessage` thread item, so the
// wrapper we added in codexPromptPayload comes back with it. Strip it before the
// item reaches the feed: otherwise the instructions are shown to the user, and the
// body no longer matches the optimistic local bubble it is meant to replace.
export function stripDeveloperInstructions(prompt: string): string {
  return prompt.replace(/^\s*<developer_instructions>[\s\S]*?<\/developer_instructions>\s*/, "");
}
