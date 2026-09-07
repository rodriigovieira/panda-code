import { describe, expect, it } from "vitest";

import { PROMPT_HISTORY_COLLAPSED_CHARACTERS, promptHistoryPreview } from "./prompt-history";

describe("promptHistoryPreview", () => {
  it("shows the first 500 characters of a collapsed prompt", () => {
    const prompt = `${"a".repeat(PROMPT_HISTORY_COLLAPSED_CHARACTERS)}hidden tail`;

    expect(promptHistoryPreview(prompt, false)).toEqual({
      text: "a".repeat(PROMPT_HISTORY_COLLAPSED_CHARACTERS),
      collapsible: true,
    });
  });

  it("shows the complete prompt after it is expanded", () => {
    const prompt = `${"a".repeat(PROMPT_HISTORY_COLLAPSED_CHARACTERS)}hidden tail`;

    expect(promptHistoryPreview(prompt, true)).toEqual({
      text: prompt,
      collapsible: true,
    });
  });

  it("does not collapse a prompt at the 500-character limit", () => {
    const prompt = "b".repeat(PROMPT_HISTORY_COLLAPSED_CHARACTERS);

    expect(promptHistoryPreview(prompt, false)).toEqual({
      text: prompt,
      collapsible: false,
    });
  });
});
