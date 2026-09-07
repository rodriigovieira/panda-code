import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();
const MAX_BYTES = 16 * 1024 * 1024;
http.route({ path: "/media/upload", method: "POST", handler: httpAction(async (ctx, request) => {
  const deviceId = request.headers.get("X-Panda-Device") ?? "";
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  let generation: string;
  try { generation = await ctx.runMutation(internal.media.reserveUpload, { deviceId, token }); }
  catch { return new Response("Upload not authorized or rate limited", { status: 403 }); }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (contentLength > MAX_BYTES) return new Response("Media too large", { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response("Missing media", { status: 400 });
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return new Response("Media too large", { status: 413 }); }
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    if (!size) return new Response("Missing media", { status: 400 });
    const storageId = await ctx.storage.store(new Blob(chunks, { type: "text/plain" }));
    try {
      await ctx.runMutation(internal.media.finishUpload, { deviceId, token, storageId, generation });
    } catch {
      await ctx.storage.delete(storageId);
      return new Response("Upload authorization changed", { status: 403 });
    }
    return Response.json({ storageId });
  } finally { reader.releaseLock(); }
}) });
export default http;
