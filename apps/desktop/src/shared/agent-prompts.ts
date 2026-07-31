// Instruction appended to every main agent session so the final message of a
// turn includes a short, human-readable recap.
export const tldrSystemPrompt =
  "At the very end of your FINAL response for a turn - only once you have finished all work and are done calling tools - " +
  "append a short recap: an empty line, then a markdown horizontal rule (`---`) on its own line, then a single line that " +
  "starts with `**TL;DR:**` followed by a one- or two-sentence summary of what you did or found. " +
  "Do NOT include a TL;DR in intermediate messages where you are still working or about to call a tool, and never add more than one TL;DR per turn.";

export function codexPromptPayload(prompt: string): string {
  const trimmedPrompt = prompt.replace(/\r+$/, "");
  return ["<developer_instructions>", tldrSystemPrompt, "</developer_instructions>", "", trimmedPrompt].join("\n");
}

// Codex echoes the submitted payload back as a `userMessage` thread item, so the
// wrapper we added in codexPromptPayload comes back with it. Strip it before the
// item reaches the feed: otherwise the instructions are shown to the user, and the
// body no longer matches the optimistic local bubble it is meant to replace.
export function stripDeveloperInstructions(prompt: string): string {
  return prompt.replace(/^\s*<developer_instructions>[\s\S]*?<\/developer_instructions>\s*/, "");
}
