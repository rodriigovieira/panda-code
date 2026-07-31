import { describe, expect, it } from "vitest";
import { editingSequenceForKey, type TerminalKeyEvent } from "./terminal-keys";

const base: TerminalKeyEvent = { key: "", altKey: false, ctrlKey: false, metaKey: false };
const ev = (over: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({ ...base, ...over });

describe("editingSequenceForKey", () => {
  it("deletes a character on plain Backspace", () => {
    expect(editingSequenceForKey(ev({ key: "Backspace" }))).toBe("\x7f");
  });

  it("deletes the previous word with Option or Ctrl + Backspace", () => {
    expect(editingSequenceForKey(ev({ key: "Backspace", altKey: true }))).toBe("\x17");
    expect(editingSequenceForKey(ev({ key: "Backspace", ctrlKey: true }))).toBe("\x17");
  });

  it("deletes to line start with Cmd + Backspace", () => {
    expect(editingSequenceForKey(ev({ key: "Backspace", metaKey: true }))).toBe("\x15");
  });

  it("moves by word with Option or Ctrl + Arrow", () => {
    expect(editingSequenceForKey(ev({ key: "ArrowLeft", altKey: true }))).toBe("\x1bb");
    expect(editingSequenceForKey(ev({ key: "ArrowRight", altKey: true }))).toBe("\x1bf");
    expect(editingSequenceForKey(ev({ key: "ArrowLeft", ctrlKey: true }))).toBe("\x1bb");
    expect(editingSequenceForKey(ev({ key: "ArrowRight", ctrlKey: true }))).toBe("\x1bf");
  });

  it("jumps to line start/end with Cmd + Arrow", () => {
    expect(editingSequenceForKey(ev({ key: "ArrowLeft", metaKey: true }))).toBe("\x01");
    expect(editingSequenceForKey(ev({ key: "ArrowRight", metaKey: true }))).toBe("\x05");
  });

  it("forward-deletes with Delete, by word when modified", () => {
    expect(editingSequenceForKey(ev({ key: "Delete" }))).toBe("\x1b[3~");
    expect(editingSequenceForKey(ev({ key: "Delete", altKey: true }))).toBe("\x1bd");
  });

  it("lets xterm handle plain arrows and unrelated keys", () => {
    expect(editingSequenceForKey(ev({ key: "ArrowLeft" }))).toBeNull();
    expect(editingSequenceForKey(ev({ key: "ArrowRight" }))).toBeNull();
    expect(editingSequenceForKey(ev({ key: "Enter" }))).toBeNull();
    expect(editingSequenceForKey(ev({ key: "a" }))).toBeNull();
  });
});
