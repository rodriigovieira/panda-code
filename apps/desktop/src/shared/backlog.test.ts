import { describe, expect, it } from "vitest";
import {
  activeItemsInColumn,
  addBacklogItem,
  backlogFileName,
  backlogSessionPrompt,
  deleteBacklogItem,
  emptyBacklog,
  findBacklogItem,
  hasEvidence,
  isColumnVisible,
  itemsForSection,
  itemsInColumn,
  linkBacklogSection,
  moveBacklogItem,
  normalizeColumn,
  onHoldItems,
  parseBacklog,
  renderBacklog,
  renderBacklogItemDetail,
  unlinkBacklogSection,
  updateBacklogItem,
  MAX_ATTACHMENTS,
  MAX_BACKLOG_ITEMS,
  MAX_LINKED_SECTIONS,
  TITLE_CAP,
  VERIFICATION_NOTES_CAP,
  type BacklogAttachment,
  type WorkspaceBacklog,
} from "./backlog";

const NOW = "2026-08-03T10:00:00.000Z";

function board(titles: { title: string; column?: string }[]): WorkspaceBacklog {
  return titles.reduce((backlog, spec, index) => {
    const result = addBacklogItem(backlog, { title: spec.title, column: spec.column }, NOW, `id-${index}`);
    if (!result.ok) throw new Error(result.message);
    return result.backlog;
  }, emptyBacklog("/repo", NOW));
}

describe("normalizeColumn", () => {
  it("takes the canonical tokens", () => {
    expect(normalizeColumn("in_progress")).toBe("in_progress");
    expect(normalizeColumn("done")).toBe("done");
  });

  it("takes the words an agent actually types", () => {
    expect(normalizeColumn("doing")).toBe("in_progress");
    expect(normalizeColumn("In Progress")).toBe("in_progress");
    expect(normalizeColumn("todo")).toBe("backlog");
    expect(normalizeColumn("completed")).toBe("done");
  });

  it("refuses what it cannot map, rather than guessing", () => {
    expect(normalizeColumn("blocked")).toBeUndefined();
    expect(normalizeColumn(undefined)).toBeUndefined();
  });

  it("maps the words that mean the triage inbox", () => {
    expect(normalizeColumn("pending")).toBe("pending");
    expect(normalizeColumn("triage")).toBe("pending");
    expect(normalizeColumn("inbox")).toBe("pending");
    expect(normalizeColumn("Unreviewed")).toBe("pending");
  });

  it("maps the words that mean work handed back for sign-off", () => {
    expect(normalizeColumn("review")).toBe("review");
    expect(normalizeColumn("in review")).toBe("review");
    expect(normalizeColumn("Ready for review")).toBe("review");
    expect(normalizeColumn("qa")).toBe("review");
    expect(normalizeColumn("verify")).toBe("review");
  });
});

describe("isColumnVisible", () => {
  it("draws the four ordinary columns whether or not they hold anything", () => {
    for (const column of ["backlog", "in_progress", "review", "done"] as const) {
      expect(isColumnVisible(column, 0)).toBe(true);
    }
  });

  it("hides pending until something is filed into it", () => {
    expect(isColumnVisible("pending", 0)).toBe(false);
    expect(isColumnVisible("pending", 1)).toBe(true);
  });
});

describe("addBacklogItem", () => {
  it("files a card at the top of its column", () => {
    const first = addBacklogItem(emptyBacklog("/repo", NOW), { title: "First" }, NOW, "a");
    expect(first.ok).toBe(true);
    const second = addBacklogItem((first as { backlog: WorkspaceBacklog }).backlog, { title: "Second" }, NOW, "b");
    expect(second.ok && second.backlog.items.map((item) => item.title)).toEqual(["Second", "First"]);
  });

  it("records the agent that filed it", () => {
    const result = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Fix relay", createdBy: "agent", createdBySection: "Relay work" }, NOW, "a");
    expect(result.ok && result.item?.createdBy).toBe("agent");
    expect(result.ok && result.item?.createdBySection).toBe("Relay work");
  });

  it("refuses an empty title and an unknown column", () => {
    expect(addBacklogItem(emptyBacklog("/repo", NOW), { title: "   " }, NOW).ok).toBe(false);
    const bad = addBacklogItem(emptyBacklog("/repo", NOW), { title: "x", column: "blocked" }, NOW);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.message).toContain("blocked");
  });

  it("caps a runaway title", () => {
    const result = addBacklogItem(emptyBacklog("/repo", NOW), { title: "x".repeat(TITLE_CAP + 50) }, NOW, "a");
    expect(result.ok && result.item?.title.length).toBe(TITLE_CAP);
  });

  it("stops filling once the board is full", () => {
    let backlog = emptyBacklog("/repo", NOW);
    for (let index = 0; index < MAX_BACKLOG_ITEMS; index += 1) {
      const result = addBacklogItem(backlog, { title: `item ${index}` }, NOW, `id-${index}`);
      if (!result.ok) throw new Error(result.message);
      backlog = result.backlog;
    }
    expect(addBacklogItem(backlog, { title: "one too many" }, NOW).ok).toBe(false);
  });
});

describe("updateBacklogItem", () => {
  it("changes only the fields it was given", () => {
    const start = board([{ title: "Ship it" }]);
    const patched = updateBacklogItem(start, "id-0", { description: "with tests" }, NOW);
    expect(patched.ok && patched.item?.title).toBe("Ship it");
    expect(patched.ok && patched.item?.description).toBe("with tests");
  });

  it("keeps the TL;DR on one line, however it was typed", () => {
    const start = board([{ title: "Ship it" }]);
    const patched = updateBacklogItem(start, "id-0", { summary: "Half done.\n\nThe rest needs a review." }, NOW);
    expect(patched.ok && patched.item?.summary).toBe("Half done. The rest needs a review.");
  });

  it("moves between columns and says so", () => {
    const start = board([{ title: "Ship it" }]);
    const moved = updateBacklogItem(start, "id-0", { column: "doing" }, NOW);
    expect(moved.ok && moved.item?.column).toBe("in_progress");
    expect(moved.ok && moved.message).toContain("In progress");
  });

  it("names the item by a title fragment when the id is not to hand", () => {
    const start = board([{ title: "Fix the relay retention job" }]);
    expect(updateBacklogItem(start, "retention", { column: "done" }, NOW).ok).toBe(true);
  });

  it("refuses an ambiguous match rather than editing the wrong card", () => {
    const start = board([{ title: "Fix relay" }, { title: "Fix relay retention" }]);
    const result = updateBacklogItem(start, "fix relay", { column: "done" }, NOW);
    expect(result.ok).toBe(false);
  });
});

describe("moveBacklogItem", () => {
  it("reorders within a column", () => {
    const start = board([{ title: "C" }, { title: "B" }, { title: "A" }]);
    // Added top-first, so the board reads A, B, C.
    expect(itemsInColumn(start, "backlog").map((item) => item.title)).toEqual(["A", "B", "C"]);

    const moved = moveBacklogItem(start, "id-0", "backlog", 0, NOW);
    expect(moved.ok && itemsInColumn(moved.backlog, "backlog").map((item) => item.title)).toEqual(["C", "A", "B"]);
  });

  it("moves across columns at a position, leaving the other columns alone", () => {
    const start = board([{ title: "Done thing", column: "done" }, { title: "B" }, { title: "A" }]);
    const moved = moveBacklogItem(start, "id-2", "done", 0, NOW);
    expect(moved.ok && itemsInColumn(moved.backlog, "done").map((item) => item.title)).toEqual(["A", "Done thing"]);
    expect(moved.ok && itemsInColumn(moved.backlog, "backlog").map((item) => item.title)).toEqual(["B"]);
  });

  it("clamps a position past the end of the column", () => {
    const start = board([{ title: "B" }, { title: "A" }]);
    const moved = moveBacklogItem(start, "id-1", "done", 99, NOW);
    expect(moved.ok && itemsInColumn(moved.backlog, "done").map((item) => item.title)).toEqual(["A"]);
  });
});

describe("deleteBacklogItem", () => {
  it("removes the named card and reports the rest", () => {
    const start = board([{ title: "B" }, { title: "A" }]);
    const result = deleteBacklogItem(start, "id-0", NOW);
    expect(result.ok && result.backlog.items.map((item) => item.title)).toEqual(["A"]);
  });

  it("says the board is empty rather than pointing at a list that is not there", () => {
    const result = deleteBacklogItem(emptyBacklog("/repo", NOW), "anything", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("empty");
  });
});

describe("card numbers", () => {
  it("counts up from 1 in the order cards were filed", () => {
    const start = board([{ title: "First" }, { title: "Second" }, { title: "Third" }]);
    expect(start.items.map((item) => [item.title, item.number])).toEqual([
      ["Third", 3],
      ["Second", 2],
      ["First", 1],
    ]);
    expect(start.nextNumber).toBe(4);
  });

  it("never reuses the number of a deleted card", () => {
    const start = board([{ title: "First" }, { title: "Second" }]);
    const deleted = deleteBacklogItem(start, "#2", NOW);
    expect(deleted.ok).toBe(true);
    const next = deleted.ok ? addBacklogItem(deleted.backlog, { title: "Third" }, NOW, "id-2") : null;
    expect(next?.ok && next.item?.number).toBe(3);
  });

  it("numbers a board written before numbers existed, oldest card first", () => {
    // Board order, not filing order: the newer card sits on top, and the one
    // filed first still gets #1.
    const text = JSON.stringify({
      cwd: "/repo",
      items: [
        { id: "b", title: "Filed second", createdAt: "2026-08-02T10:00:00.000Z" },
        { id: "a", title: "Filed first", createdAt: "2026-08-01T10:00:00.000Z" },
      ],
    });
    const parsed = parseBacklog(text, "/repo", NOW);
    expect(parsed.items.map((item) => [item.title, item.number])).toEqual([
      ["Filed second", 2],
      ["Filed first", 1],
    ]);
    expect(parsed.nextNumber).toBe(3);
    // Same file, same numbers: nothing is written back until the next mutation.
    expect(parseBacklog(text, "/repo", NOW).items.map((item) => item.number)).toEqual([2, 1]);
  });

  it("does not hand out a number a hand-edited card already carries", () => {
    const parsed = parseBacklog(JSON.stringify({ cwd: "/repo", items: [{ id: "a", title: "Kept", number: 40 }] }), "/repo", NOW);
    const added = addBacklogItem(parsed, { title: "New" }, NOW, "b");
    expect(added.ok && added.item?.number).toBe(41);
  });
});

describe("findBacklogItem", () => {
  it("matches an id prefix", () => {
    const start = board([{ title: "A" }]);
    expect(findBacklogItem(start, "id-")?.title).toBe("A");
  });

  it("matches a card number, with or without the hash", () => {
    const start = board([{ title: "First" }, { title: "Second" }]);
    expect(findBacklogItem(start, "#1")?.title).toBe("First");
    expect(findBacklogItem(start, "2")?.title).toBe("Second");
    expect(findBacklogItem(start, "#99")).toBeUndefined();
  });

  it("returns nothing for an empty needle", () => {
    expect(findBacklogItem(board([{ title: "A" }]), "  ")).toBeUndefined();
  });
});

describe("parseBacklog", () => {
  it("survives a truncated or hand-mangled file", () => {
    expect(parseBacklog("{not json", "/repo", NOW).items).toEqual([]);
    expect(parseBacklog("null", "/repo", NOW).items).toEqual([]);
    expect(parseBacklog('{"items": 3}', "/repo", NOW).items).toEqual([]);
  });

  it("drops items with no title and de-duplicates ids", () => {
    const text = JSON.stringify({
      cwd: "/repo",
      items: [
        { id: "a", title: "Keep" },
        { id: "a", title: "Duplicate id" },
        { id: "b", title: "  " },
      ],
    });
    expect(parseBacklog(text, "/repo", NOW).items.map((item) => item.title)).toEqual(["Keep"]);
  });

  it("normalizes a legacy or hand-typed column", () => {
    const text = JSON.stringify({ items: [{ id: "a", title: "Keep", column: "doing" }] });
    expect(parseBacklog(text, "/repo", NOW).items[0]?.column).toBe("in_progress");
  });

  it("round-trips what the mutations wrote", () => {
    const start = board([{ title: "B", column: "done" }, { title: "A" }]);
    expect(parseBacklog(JSON.stringify(start), "/repo", NOW)).toEqual(start);
  });
});

describe("renderBacklog", () => {
  it("names every column, with the card number an agent needs to act", () => {
    const rendered = renderBacklog(board([{ title: "Ship it" }]));
    expect(rendered).toContain("## Backlog (1)");
    expect(rendered).toContain("## In progress (0)");
    expect(rendered).toContain("**Ship it**");
    expect(rendered).toContain("`#1`");
  });

  it("shows the TL;DR, so a board can be read without opening every card", () => {
    const start = board([{ title: "Ship it" }]);
    const summarized = updateBacklogItem(start, "id-0", { summary: "Blocked on the relay deploy." }, NOW);
    expect(summarized.ok && renderBacklog(summarized.backlog)).toContain("TL;DR: Blocked on the relay deploy.");
  });

  it("tells an agent what to do with an empty board", () => {
    expect(renderBacklog(emptyBacklog("/repo", NOW))).toContain("backlog_add");
  });

  it("narrows to one column when asked", () => {
    const rendered = renderBacklog(board([{ title: "Ship it" }]), "done");
    expect(rendered).toContain("## Done (0)");
    expect(rendered).not.toContain("Ship it");
  });

  it("leaves an empty pending column out entirely", () => {
    expect(renderBacklog(board([{ title: "Ship it" }]))).not.toContain("Pending");
  });

  it("shows pending once something is filed there, flagged as untriaged", () => {
    const rendered = renderBacklog(board([{ title: "Suspicious retry loop", column: "pending" }]));
    expect(rendered).toContain("## Pending (1)");
    expect(rendered).toContain("not yet triaged");
    expect(rendered).toContain("**Suspicious retry loop**");
  });

  it("still answers for pending when asked for it by name, so a triage check is never silence", () => {
    expect(renderBacklog(board([{ title: "Ship it" }]), "pending")).toContain("## Pending (0)");
  });
});

describe("on hold", () => {
  function held(): WorkspaceBacklog {
    const start = board([{ title: "Ship it" }, { title: "Someday" }]);
    const result = updateBacklogItem(start, "id-1", { onHold: true }, NOW);
    if (!result.ok) throw new Error(result.message);
    return result.backlog;
  }

  it("parks a card without moving it out of its column", () => {
    const backlog = held();
    const item = findBacklogItem(backlog, "id-1");
    expect(item?.onHold).toBe(true);
    expect(item?.column).toBe("backlog");
    expect(itemsInColumn(backlog, "backlog")).toHaveLength(2);
    expect(activeItemsInColumn(backlog, "backlog").map((card) => card.title)).toEqual(["Ship it"]);
    expect(onHoldItems(backlog).map((card) => card.title)).toEqual(["Someday"]);
  });

  it("comes back to the column it was parked from", () => {
    const back = updateBacklogItem(held(), "id-1", { onHold: false }, NOW);
    expect(back.ok && back.item?.onHold).toBeUndefined();
    expect(back.ok && back.item?.column).toBe("backlog");
    expect(back.ok && activeItemsInColumn(back.backlog, "backlog")).toHaveLength(2);
  });

  it("leaves the flag alone on an edit that says nothing about it", () => {
    const edited = updateBacklogItem(held(), "id-1", { summary: "Still parked." }, NOW);
    expect(edited.ok && edited.item?.onHold).toBe(true);
  });

  it("keeps parked cards out of the columns an agent reads, and lists them apart", () => {
    const rendered = renderBacklog(held());
    expect(rendered).toContain("## Backlog (1)");
    expect(rendered).toContain("## On hold (1)");
    // Named in its own section, and only there.
    expect(rendered.slice(0, rendered.indexOf("## On hold"))).not.toContain("Someday");
    expect(rendered).toContain("_(on hold, from Backlog)_");
  });

  it("survives a round trip through the file", () => {
    const reread = parseBacklog(JSON.stringify(held()), "/repo", NOW);
    expect(onHoldItems(reread).map((card) => card.title)).toEqual(["Someday"]);
  });

  it("writes nothing for a card that was never parked, so old boards are untouched", () => {
    const plain = board([{ title: "Ship it" }]);
    expect(JSON.stringify(plain)).not.toContain("onHold");
  });
});

describe("section links", () => {
  it("links a section once, however many times it is asked", () => {
    const linked = linkBacklogSection(board([{ title: "Ship it" }]), "id-0", "sec-1", NOW);
    expect(linked.ok && linked.item?.sections).toEqual(["sec-1"]);
    const again = linkBacklogSection(linked.ok ? linked.backlog : emptyBacklog("/repo"), "id-0", "sec-1", NOW);
    expect(again.ok && again.item?.sections).toEqual(["sec-1"]);
  });

  it("keeps a card with no links free of the field", () => {
    const linked = linkBacklogSection(board([{ title: "Ship it" }]), "id-0", "sec-1", NOW);
    const unlinked = unlinkBacklogSection(linked.ok ? linked.backlog : emptyBacklog("/repo"), "id-0", "sec-1", NOW);
    expect(unlinked.ok && unlinked.item?.sections).toBeUndefined();
  });

  it("finds every card a section is working on, in board order", () => {
    let backlog = board([{ title: "First" }, { title: "Second" }, { title: "Third" }]);
    for (const id of ["id-0", "id-2"]) {
      const result = linkBacklogSection(backlog, id, "sec-1", NOW);
      backlog = result.ok ? result.backlog : backlog;
    }
    // The board files new cards at the top, so "Third" comes before "First".
    expect(itemsForSection(backlog, "sec-1").map((item) => item.title)).toEqual(["Third", "First"]);
    expect(itemsForSection(backlog, "sec-2")).toEqual([]);
  });

  it("links the editing section as a side effect of an edit", () => {
    const moved = updateBacklogItem(board([{ title: "Ship it" }]), "id-0", { column: "done", linkSection: "sec-1" }, NOW);
    expect(moved.ok && moved.item?.column).toBe("done");
    expect(moved.ok && moved.item?.sections).toEqual(["sec-1"]);
  });

  it("survives a round trip through the file, blanks and duplicates dropped", () => {
    const written = JSON.stringify({
      version: 1,
      cwd: "/repo",
      items: [{ id: "a", title: "Ship it", sections: ["sec-1", "sec-1", "  ", 7, "sec-2"] }],
      updatedAt: NOW,
    });
    expect(parseBacklog(written, "/repo", NOW).items[0]?.sections).toEqual(["sec-1", "sec-2"]);
  });

  it("caps a runaway card and keeps the newest links", () => {
    let backlog = board([{ title: "Ship it" }]);
    for (let index = 0; index < MAX_LINKED_SECTIONS + 3; index += 1) {
      const result = linkBacklogSection(backlog, "id-0", `sec-${index}`, NOW);
      backlog = result.ok ? result.backlog : backlog;
    }
    const sections = backlog.items[0]?.sections ?? [];
    expect(sections).toHaveLength(MAX_LINKED_SECTIONS);
    expect(sections.at(-1)).toBe(`sec-${MAX_LINKED_SECTIONS + 2}`);
  });
});

function attachment(id: string, overrides: Partial<BacklogAttachment> = {}): BacklogAttachment {
  return {
    id,
    kind: "image",
    path: `/tmp/attachments/${id}.png`,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 1024,
    createdAt: NOW,
    ...overrides,
  };
}

describe("attachments", () => {
  it("files with attachments and verification notes already resolved", () => {
    const result = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: [attachment("a")], verificationNotes: "Checked in the browser." }, NOW, "id-0");
    expect(result.ok && result.item?.attachments?.map((a) => a.id)).toEqual(["a"]);
    expect(result.ok && result.item?.verificationNotes).toBe("Checked in the browser.");
  });

  it("appends attachments additively, without touching existing ones", () => {
    const start = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: [attachment("a")] }, NOW, "id-0");
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const patched = updateBacklogItem(backlog, "id-0", { addAttachments: [attachment("b")] }, NOW);
    expect(patched.ok && patched.item?.attachments?.map((a) => a.id)).toEqual(["a", "b"]);
    expect(patched.ok && patched.message).toContain("Attached 1 file");
  });

  it("drops the attachments it was told to remove", () => {
    const start = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: [attachment("a"), attachment("b")] }, NOW, "id-0");
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const patched = updateBacklogItem(backlog, "id-0", { removeAttachmentIds: ["a"] }, NOW);
    expect(patched.ok && patched.item?.attachments?.map((a) => a.id)).toEqual(["b"]);
  });

  it("clears the field entirely once the last attachment is removed", () => {
    const start = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: [attachment("a")] }, NOW, "id-0");
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const patched = updateBacklogItem(backlog, "id-0", { removeAttachmentIds: ["a"] }, NOW);
    expect(patched.ok && patched.item?.attachments).toBeUndefined();
  });

  it("refuses to grow a card past the attachment cap", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => attachment(`a${index}`));
    const start = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: many }, NOW, "id-0");
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const patched = updateBacklogItem(backlog, "id-0", { addAttachments: [attachment("one-too-many")] }, NOW);
    expect(patched.ok).toBe(false);
    expect(patched.ok === false && patched.message).toContain(String(MAX_ATTACHMENTS));
  });

  it("caps verification notes the same way description is capped", () => {
    const start = board([{ title: "Ship it" }]);
    const patched = updateBacklogItem(start, "id-0", { verificationNotes: "x".repeat(VERIFICATION_NOTES_CAP + 50) }, NOW);
    expect(patched.ok && patched.item?.verificationNotes?.length).toBe(VERIFICATION_NOTES_CAP);
  });

  it("leaves attachments and notes alone on an edit that says nothing about them", () => {
    const start = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Ship it", attachments: [attachment("a")], verificationNotes: "Checked." }, NOW, "id-0");
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const patched = updateBacklogItem(backlog, "id-0", { summary: "Still true." }, NOW);
    expect(patched.ok && patched.item?.attachments?.map((a) => a.id)).toEqual(["a"]);
    expect(patched.ok && patched.item?.verificationNotes).toBe("Checked.");
  });

  it("survives a round trip through the file", () => {
    const start = addBacklogItem(
      emptyBacklog("/repo", NOW),
      { title: "Ship it", attachments: [attachment("a", { kind: "video", caption: "Full flow" })], verificationNotes: "Recorded the flow." },
      NOW,
      "id-0",
    );
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const reread = parseBacklog(JSON.stringify(backlog), "/repo", NOW);
    expect(reread.items[0]?.attachments?.[0]?.kind).toBe("video");
    expect(reread.items[0]?.attachments?.[0]?.caption).toBe("Full flow");
    expect(reread.items[0]?.verificationNotes).toBe("Recorded the flow.");
  });

  it("drops a malformed attachment off disk rather than failing the whole card", () => {
    const text = JSON.stringify({
      cwd: "/repo",
      items: [{ id: "a", title: "Keep", attachments: [{ id: "1", kind: "image", path: "/x.png", name: "x.png" }, { id: "2", kind: "pdf", path: "/x.pdf", name: "x.pdf" }, "not an object"] }],
    });
    const parsed = parseBacklog(text, "/repo", NOW);
    expect(parsed.items[0]?.attachments?.map((a) => a.id)).toEqual(["1"]);
  });

  it("writes nothing for a card with neither, so old boards stay untouched", () => {
    const plain = board([{ title: "Ship it" }]);
    expect(JSON.stringify(plain)).not.toContain("attachments");
    expect(JSON.stringify(plain)).not.toContain("verificationNotes");
  });

  it("shows the count and kind on the rendered board, and the id in the card's own detail", () => {
    const start = addBacklogItem(
      emptyBacklog("/repo", NOW),
      { title: "Ship it", attachments: [attachment("a"), attachment("b", { kind: "video" })], verificationNotes: "Checked both paths." },
      NOW,
      "id-0",
    );
    const backlog = start.ok ? start.backlog : emptyBacklog("/repo", NOW);
    const rendered = renderBacklog(backlog);
    expect(rendered).toContain("attachments: 2 (1 image, 1 video)");
    expect(rendered).toContain("verification: Checked both paths.");

    const item = start.ok ? start.item : undefined;
    const detail = item ? renderBacklogItemDetail(item) : "";
    expect(detail).toContain("`a`");
    expect(detail).toContain("`b`");
  });
});

describe("the evidence bar on done", () => {
  function carded(overrides: Parameters<typeof addBacklogItem>[1] = { title: "Ship it" }): WorkspaceBacklog {
    const result = addBacklogItem(emptyBacklog("/repo", NOW), { column: "in_progress", ...overrides }, NOW, "id-0");
    if (!result.ok) throw new Error(result.message);
    return result.backlog;
  }

  it("counts either half as evidence, and blank notes as neither", () => {
    expect(hasEvidence({ verificationNotes: "Ran the migration.", attachments: undefined })).toBe(true);
    expect(hasEvidence({ verificationNotes: undefined, attachments: [attachment("a")] })).toBe(true);
    expect(hasEvidence({ verificationNotes: undefined, attachments: undefined })).toBe(false);
    expect(hasEvidence({ verificationNotes: "   \n ", attachments: [] })).toBe(false);
  });

  it("turns an agent's bare close into a pointer at Review", () => {
    const result = updateBacklogItem(carded(), "id-0", { column: "done", requireEvidence: true }, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("#1 can't go to Done without evidence");
    expect(!result.ok && result.message).toContain("Review");
  });

  it("lets the agent hand work back to Review with nothing at all", () => {
    // The column an agent can always reach: the bar is on closing the card, not
    // on admitting the work is finished.
    const result = updateBacklogItem(carded(), "id-0", { column: "review", requireEvidence: true }, NOW);
    expect(result.ok && result.item?.column).toBe("review");
  });

  it("lets the agent close a card whose evidence lands in the same call", () => {
    const result = updateBacklogItem(
      carded(),
      "id-0",
      { column: "done", verificationNotes: "`pnpm test` — 41 passed.", requireEvidence: true },
      NOW,
    );
    expect(result.ok && result.item?.column).toBe("done");
  });

  it("takes an attachment as the evidence, with no note written", () => {
    const result = updateBacklogItem(carded(), "id-0", { column: "done", addAttachments: [attachment("a")], requireEvidence: true }, NOW);
    expect(result.ok && result.item?.column).toBe("done");
  });

  it("takes evidence already on the card from an earlier call", () => {
    const board = carded({ title: "Ship it", verificationNotes: "Queried the deployment." });
    const result = updateBacklogItem(board, "id-0", { column: "done", requireEvidence: true }, NOW);
    expect(result.ok && result.item?.column).toBe("done");
  });

  it("leaves the user's own close alone", () => {
    // The app's mutation path never sets the flag: the user IS the review step,
    // so gating them would be gating the wrong side of the board.
    const result = updateBacklogItem(carded(), "id-0", { column: "done" }, NOW);
    expect(result.ok && result.item?.column).toBe("done");
  });

  it("gates the transition, not every edit of a card already closed", () => {
    const board = carded({ title: "Ship it", column: "done" });
    const result = updateBacklogItem(board, "id-0", { summary: "Fixing the TL;DR months later", requireEvidence: true }, NOW);
    expect(result.ok).toBe(true);
  });

  it("holds a card filed straight into done to the same bar", () => {
    const bare = addBacklogItem(emptyBacklog("/repo", NOW), { title: "Already shipped", column: "done", requireEvidence: true }, NOW, "id-0");
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.message).toContain("can't go to Done without evidence");

    const proven = addBacklogItem(
      emptyBacklog("/repo", NOW),
      { title: "Already shipped", column: "done", verificationNotes: "curl → 200, body matched.", requireEvidence: true },
      NOW,
      "id-0",
    );
    expect(proven.ok && proven.item?.column).toBe("done");
  });
});

describe("backlogFileName", () => {
  it("flattens a path the same way the Claude CLI does", () => {
    expect(backlogFileName("/Users/me/code/panda")).toBe("-Users-me-code-panda.json");
  });
});

describe("backlogSessionPrompt", () => {
  it("reads like the user typed one card themselves", () => {
    expect(backlogSessionPrompt([{ title: "Fix the flake", description: "It hits the inbox timer." }])).toBe(
      "Fix the flake\n\nIt hits the inbox timer.",
    );
    expect(backlogSessionPrompt([{ title: "Fix the flake", description: "  " }])).toBe("Fix the flake");
  });

  it("separates several cards so the second title is not read as the first body", () => {
    const text = backlogSessionPrompt([
      { title: "One", description: "first" },
      { title: "Two", description: "" },
    ]);
    expect(text).toBe("One\n\nfirst\n\n---\n\nTwo");
  });
});
