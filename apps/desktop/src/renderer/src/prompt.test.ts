import { describe, expect, it } from "vitest";
import { buildPromptWithImageAttachments } from "./prompt";

describe("buildPromptWithImageAttachments", () => {
  it("returns the trimmed prompt when no images are attached", () => {
    expect(buildPromptWithImageAttachments(" hello ", [])).toBe("hello");
  });

  it("adds image file paths to the prompt", () => {
    expect(buildPromptWithImageAttachments("What is this?", ["/tmp/a.png", "/tmp/b.jpg"])).toBe(
      "What is this?\n\nAttached image files:\n- /tmp/a.png\n- /tmp/b.jpg",
    );
  });

  it("uses a default prompt when only images are attached", () => {
    expect(buildPromptWithImageAttachments("", ["/tmp/a.png"])).toBe(
      "Please inspect the attached image(s).\n\nAttached image file:\n- /tmp/a.png",
    );
  });
});
