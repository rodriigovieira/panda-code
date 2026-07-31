export type BodyBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; items: Array<{ text: string; checked?: boolean }> }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "code"; code: string; language?: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "task-notification"; taskId?: string; summary?: string; event?: string };

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function readTag(value: string, tag: string): string | undefined {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  const content = match?.[1]?.trim();
  return content ? decodeXmlEntities(content) : undefined;
}

export function parseTaskNotification(value: string): Extract<BodyBlock, { type: "task-notification" }> | null {
  const trimmed = value.trim();
  if (!/^<task-notification>[\s\S]*<\/task-notification>$/i.test(trimmed)) {
    return null;
  }

  return {
    type: "task-notification",
    taskId: readTag(trimmed, "task-id"),
    summary: readTag(trimmed, "summary"),
    event: readTag(trimmed, "event"),
  };
}

function shouldStartNewParagraph(line: string): boolean {
  return (
    /^\d+\.\s+/.test(line) ||
    /^#{1,3}\s+/.test(line) ||
    /^(Good news|What already exists|The gap|What I'd add|Worth doing|The fix|The recommendation|Next step|Why it matters|Risk|Result|Summary):/i.test(
      line,
    )
  );
}

function joinParagraph(lines: string[]): string {
  return lines.join("\n").trim();
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeTableRows(rows: string[][], columnCount: number): string[][] {
  return rows.map((row) => {
    if (row.length === columnCount) {
      return row;
    }

    if (row.length > columnCount) {
      return [...row.slice(0, columnCount - 1), row.slice(columnCount - 1).join(" | ")];
    }

    return [...row, ...Array.from({ length: columnCount - row.length }, () => "")];
  });
}

export function parseBodyBlocks(value: string): BodyBlock[] {
  const taskNotification = parseTaskNotification(value);
  if (taskNotification) {
    return [taskNotification];
  }

  const lines = value.split("\n");
  const blocks: BodyBlock[] = [];
  let paragraph: string[] = [];
  let listItems: Array<{ text: string; checked?: boolean }> = [];
  let listOrdered = false;
  let quoteLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: joinParagraph(paragraph) });
      paragraph = [];
    }
  };

  const flushList = (): void => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", ordered: listOrdered, items: listItems });
      listItems = [];
      listOrdered = false;
    }
  };

  const flushQuote = (): void => {
    if (quoteLines.length > 0) {
      blocks.push({ type: "quote", text: joinParagraph(quoteLines) });
      quoteLines = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const fence = trimmed.match(/^```([\w-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]?.trim() ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "code", code: codeLines.join("\n"), language: fence[1] });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (trimmed.includes("|") && isTableDivider(lines[index + 1]?.trim() ?? "")) {
      flushParagraph();
      flushList();
      flushQuote();
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index]?.trim() ?? "";
        if (!rowLine || !rowLine.includes("|")) {
          index -= 1;
          break;
        }
        rows.push(splitTableRow(rowLine));
        index += 1;
      }

      blocks.push({ type: "table", headers, rows: normalizeTableRows(rows, headers.length) });
      continue;
    }

    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: "heading", text: heading[1] ?? "" });
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: "rule" });
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1] ?? "");
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (listItems.length > 0 && listOrdered) {
        flushList();
      }
      listOrdered = false;
      const checkbox = bullet[1];
      listItems.push({ text: bullet[2] ?? "", checked: checkbox === undefined ? undefined : checkbox.toLowerCase() === "x" });
      continue;
    }

    const ordered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      const orderNumber = Number(ordered[1]);
      if (!listOrdered && orderNumber !== 1) {
        flushList();
        flushQuote();
        if (paragraph.length > 0 && shouldStartNewParagraph(trimmed)) {
          flushParagraph();
        }
        paragraph.push(trimmed);
        continue;
      }
      flushParagraph();
      flushQuote();
      if (listItems.length > 0 && !listOrdered) {
        flushList();
      }
      listOrdered = true;
      listItems.push({ text: ordered[2] ?? "" });
      continue;
    }

    flushList();
    flushQuote();
    if (paragraph.length > 0 && shouldStartNewParagraph(trimmed)) {
      flushParagraph();
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  return blocks;
}
