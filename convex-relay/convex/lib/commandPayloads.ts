import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * A command's request payload lives in its own table (`commandPayloads`) because
 * it is the one genuinely large document on the relay — `image_prep.dart` sizes
 * attachments right up to Convex's 1 MiB document cap — while the readers that
 * re-fire constantly (`commands:watchMine`, the `commands:enqueue` rate-limit
 * scan) never need it. See the schema comment for the full rationale.
 */

/** Read a command's payload, falling back to the legacy inline field. */
export async function readPayloadCipher(
  ctx: QueryCtx | MutationCtx,
  command: Doc<"commands">,
): Promise<string | undefined> {
  if (command.payloadCipher !== undefined) return command.payloadCipher;
  const row = await ctx.db
    .query("commandPayloads")
    .withIndex("by_command", (q) => q.eq("commandId", command._id))
    .unique();
  return row?.payloadCipher;
}

/** Drop a command's payload once it can no longer be needed (ack, revoke, prune). */
export async function deletePayload(
  ctx: MutationCtx,
  commandId: Id<"commands">,
): Promise<void> {
  const row = await ctx.db
    .query("commandPayloads")
    .withIndex("by_command", (q) => q.eq("commandId", commandId))
    .unique();
  if (row) await ctx.db.delete(row._id);
}
