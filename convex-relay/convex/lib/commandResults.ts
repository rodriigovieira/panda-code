import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * A command's SUCCESSFUL result lives in its own table (`commandResults`) for the
 * mirror-image reason its request payload lives in `commandPayloads`: the
 * request/response commands answer with whole kanban boards, git statuses and
 * process lists, while `commands:watchMine` — which re-fires on every status
 * transition of every row it watches — only ever needed the status. See the
 * schema comment on `commandResults` for the full rationale.
 *
 * ERROR results stay inline on the command row: they are a single sentence, and
 * explaining a rejected command is exactly what `watchMine` is for.
 */

/** Read a command's result, falling back to the legacy inline field. */
export async function readResultCipher(
  ctx: QueryCtx | MutationCtx,
  command: Doc<"commands">,
): Promise<string | undefined> {
  if (command.resultCipher !== undefined) return command.resultCipher;
  const rows = await ctx.db
    .query("commandResults")
    .withIndex("by_command", (q) => q.eq("commandId", command._id))
    .collect();
  if (rows.length === 0) return undefined;
  return rows
    .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
    .map((row) => row.resultCipher)
    .join("");
}

/** Atomically replace a successful result with bounded ciphertext pieces. */
export async function writeResultCipher(
  ctx: MutationCtx,
  commandId: Id<"commands">,
  resultCipher: string,
): Promise<void> {
  await deleteResult(ctx, commandId);
  // At most 768 KiB of UTF-8, leaving room for document fields under 1 MiB.
  // Envelopes are ASCII today; avoid splitting surrogate pairs as well.
  const chunkChars = 256 * 1024;
  let offset = 0;
  let chunkIndex = 0;
  do {
    let end = Math.min(offset + chunkChars, resultCipher.length);
    const last = resultCipher.charCodeAt(end - 1);
    if (end < resultCipher.length && last >= 0xd800 && last <= 0xdbff) end--;
    await ctx.db.insert("commandResults", {
      commandId,
      resultCipher: resultCipher.slice(offset, end),
      chunkIndex: chunkIndex++,
    });
    offset = end;
  } while (offset < resultCipher.length);
}

/** Drop a command's result once it has been read (or its command is swept). */
export async function deleteResult(
  ctx: MutationCtx,
  commandId: Id<"commands">,
): Promise<void> {
  const rows = await ctx.db
    .query("commandResults")
    .withIndex("by_command", (q) => q.eq("commandId", commandId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}
