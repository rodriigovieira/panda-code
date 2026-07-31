// xterm.js ships no word/line editing bindings, so Option/Ctrl+Arrow,
// Option/Ctrl+Backspace and Cmd+Backspace all do nothing in the shell. This
// maps the macOS editing keys to the control/escape bytes zsh's line editor
// (ZLE) understands, so we can write them straight to the pty.
//
// Kept as a pure function (no DOM) so it is unit-testable; TerminalView wires
// it into xterm's attachCustomKeyEventHandler.

export type TerminalKeyEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

// The bytes to send to the pty for an editing key, or null to let xterm handle
// the key with its own default binding (printable input, Enter, Tab, plain
// arrows in application-cursor mode, etc.).
export function editingSequenceForKey(event: TerminalKeyEvent): string | null {
  // Option (the macOS convention) OR Control (what many users reach for) both
  // act as the word-wise modifier; Command alone is the line-wise modifier.
  const word = event.altKey || event.ctrlKey;
  const line = event.metaKey && !event.altKey && !event.ctrlKey;

  switch (event.key) {
    case "ArrowLeft":
      if (line) return "\x01"; // Ctrl-A: start of line
      if (word) return "\x1bb"; // Esc-b: previous word
      return null;
    case "ArrowRight":
      if (line) return "\x05"; // Ctrl-E: end of line
      if (word) return "\x1bf"; // Esc-f: next word
      return null;
    case "Backspace":
      if (line) return "\x15"; // Ctrl-U: delete to line start
      if (word) return "\x17"; // Ctrl-W: delete previous word
      return "\x7f"; // DEL: delete character
    case "Delete": // forward delete (fn+Delete)
      return word ? "\x1bd" : "\x1b[3~"; // Esc-d: delete next word / forward-delete char
    default:
      return null;
  }
}
