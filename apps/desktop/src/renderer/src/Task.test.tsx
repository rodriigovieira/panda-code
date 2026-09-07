import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskDetail, type LinkedSection } from "./Task";
import type { BacklogItem } from "../../shared/backlog";

/**
 * Static markup only: the app has no DOM in tests, so what is asserted here is
 * what the view *says* — which fields are on it, and which doors it offers —
 * rather than what clicking does.
 */

const ITEM: BacklogItem = {
  id: "8c2d1f00-0000-4000-8000-000000000000",
  number: 12,
  title: "Collapse the three window readers",
  summary: "Three readers disagree about focus; pick one and delete the others.",
  description: "They disagree about focus.\n\n- `windowA` wins on load\n- `windowB` wins on focus\n\nPick one.",
  metadata: "size: M",
  column: "in_progress",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
  createdBy: "agent",
  createdBySection: "Window audit",
  sections: ["sec-1", "sec-gone"],
};

const SECTIONS: LinkedSection[] = [
  { id: "sec-1", title: "Window audit", present: true },
  { id: "sec-gone", title: "Deleted section", present: false },
];

function markup(overrides: Partial<Parameters<typeof TaskDetail>[0]> = {}): string {
  return renderToStaticMarkup(
    <TaskDetail
      item={ITEM}
      cwd="/repo"
      workspaceName="panda"
      sections={SECTIONS}
      onPatch={() => undefined}
      onClose={() => undefined}
      onDelete={() => undefined}
      onStartSession={() => undefined}
      onOpenSection={() => undefined}
      onUnlinkSection={() => undefined}
      {...overrides}
    />,
  );
}

describe("TaskDetail", () => {
  it("shows the card as text, not as form fields", () => {
    const html = markup();
    expect(html).toContain("Collapse the three window readers");
    expect(html).toContain("They disagree about focus.");
    expect(html).toContain("size: M");
    // The whole point of the view: a description is read, not scrolled inside
    // a textarea, until it is clicked.
    expect(html).not.toContain("<textarea");
  });

  it("renders the description as Markdown, and leads with the TL;DR", () => {
    const html = markup();
    expect(html).toContain("Three readers disagree about focus");
    // The list is a list and the code span is a code span — not literal "- " and
    // backticks, which is what the field showed before.
    expect(html).toContain("<li");
    expect(html).toContain("<code>windowA</code>");
    expect(html).not.toContain("`windowA`");
  });

  it("names the sections working on it, and marks the one that is gone", () => {
    const html = markup();
    expect(html).toContain("Window audit");
    expect(html).toContain("Deleted section");
    expect(html).toContain("is-missing");
  });

  it("says so when nothing is linked yet", () => {
    expect(markup({ sections: [] })).toContain("No section is working on this yet");
  });

  it("offers to park the card, and says so once it is parked", () => {
    const live = markup();
    expect(live).toContain("Put on hold");
    expect(live).not.toContain("backlog-hold-chip");

    const parked = markup({ item: { ...ITEM, onHold: true } });
    expect(parked).toContain("Take off hold");
    // The chip, so a card reached from a link explains why it is off the board.
    expect(parked).toContain("backlog-hold-chip");
    // Still in its column, which is where taking it off hold puts it back.
    expect(parked).toContain("In progress");
  });

  it("puts evidence above the description, and only when there is some", () => {
    const bare = markup();
    expect(bare).not.toContain("Evidence");

    const withProof = markup({
      item: {
        ...ITEM,
        attachments: [
          { id: "att-1", name: "after.png", path: "/tmp/after.png", kind: "image", mimeType: "image/png", size: 1024, createdAt: "2026-08-02T09:00:00.000Z" },
          { id: "att-2", name: "flow.mp4", path: "/tmp/flow.mp4", kind: "video", mimeType: "video/mp4", size: 4096, createdAt: "2026-08-02T09:00:00.000Z" },
        ],
      },
    });
    expect(withProof).toContain("Evidence");
    // Above the description rather than under the verification note at the
    // foot of the card: it answers "did this work?" before the prose explains
    // what "this" was.
    expect(withProof.indexOf("Evidence")).toBeLessThan(withProof.indexOf("They disagree about focus"));
    // A recording shows a frame instead of a grey rectangle.
    expect(withProof).toContain("/tmp/flow.mp4#t=0.1");
  });

  it("offers the board only when it was not opened from it", () => {
    expect(markup()).not.toContain("Open backlog");
    expect(markup({ onOpenBoard: () => undefined })).toContain("Open backlog");
  });
});
