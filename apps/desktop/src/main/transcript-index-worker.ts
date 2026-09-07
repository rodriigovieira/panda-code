import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type {
  TranscriptIndexMetadata,
  TranscriptIndexPage,
  TranscriptIndexSearchDocument,
  TranscriptIndexSearchHit,
  TranscriptIndexWorkerRequest,
  TranscriptIndexWorkerResponse,
  TranscriptRegistration,
  TranscriptRuntime,
} from "../shared/transcript-index";
import { stripDeveloperInstructions } from "../shared/agent-prompts";
import { compactSectionTitle } from "../shared/section-title";

export type WorkerConfig = { directory: string; home: string };
type OffsetRecord = { o: number; l: number; s?: string; m?: string };
type StoredMetadata = TranscriptIndexMetadata & {
  version: 5;
  mtimeMs: number;
  offsets: OffsetRecord[];
  searchBytes: number;
  currentModel?: string;
};

let config = workerData as WorkerConfig | undefined;
if (config?.directory) mkdirSync(config.directory, { recursive: true, mode: 0o700 });
const registrations = new Map<string, TranscriptRegistration & { path?: string }>();
const jobs = new Map<string, Promise<StoredMetadata>>();
const SEARCH_TEXT_CAP = 1_500_000;
const MAX_INDEX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_LINE_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
});

function sidecarBase(key: string): string {
  if (!config) throw new Error("Transcript index worker is not configured.");
  return join(config.directory, createHash("sha256").update(key).digest("hex"));
}

function metadataPath(key: string): string {
  return `${sidecarBase(key)}.json`;
}

function searchPath(key: string): string {
  return `${sidecarBase(key)}.search`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readMetadata(registration: TranscriptRegistration & { path: string }): StoredMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath(registration.key), "utf8")) as StoredMetadata;
    if (parsed.version === 5 && parsed.key === registration.key && parsed.path === registration.path) return parsed;
  } catch {
    // First index, an interrupted write, or a source path that moved.
  }
  return {
    version: 5,
    key: registration.key,
    path: registration.path,
    runtime: registration.runtime,
    indexedBytes: 0,
    sourceBytes: 0,
    mtimeMs: 0,
    tokenUsage: emptyUsage(),
    recordCount: 0,
    offsets: [],
    searchBytes: 0,
  };
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof candidate.text === "string") parts.push(candidate.text);
    else if (typeof candidate.content === "string") parts.push(candidate.content);
  }
  return parts.join("\n").trim() || null;
}

function plainTitleCandidate(value: string): string | undefined {
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? compactSectionTitle(normalized) : undefined;
}

/** Last real user request preserved inside a Claude→Codex handoff. */
function titleFromRuntimeHandoff(value: string): string | undefined {
  const handoffs = Array.from(value.matchAll(/<runtime-handoff\b[^>]*>([\s\S]*?)<\/runtime-handoff>/gi));
  for (const handoff of handoffs.reverse()) {
    const body = handoff[1] ?? "";
    const markers = Array.from(body.matchAll(/^### User @ [^\n]*\n/gm));
    const marker = markers.at(-1);
    if (!marker || marker.index === undefined) continue;
    const remainder = body.slice(marker.index + marker[0].length);
    const nextMarker = remainder.search(/\n### [^\n]+ @ /);
    const candidate = plainTitleCandidate(remainder.slice(0, nextMarker >= 0 ? nextMarker : undefined));
    if (candidate) return candidate;
  }
  return undefined;
}

function titleCandidate(value: string | null): string | undefined {
  if (!value) return undefined;
  const handoffTitle = titleFromRuntimeHandoff(value);
  const outsideHandoff = value.replace(/<runtime-handoff\b[^>]*>[\s\S]*?<\/runtime-handoff>/gi, " ");
  const outsideTitle = plainTitleCandidate(outsideHandoff);
  // "Continue" is a transport command used to resume on a different runtime,
  // not a description of the section. Prefer the request carried in the
  // handoff; a substantive prompt after the handoff still wins normally.
  if (outsideTitle && !/^continue[.!]?$/i.test(outsideTitle)) return outsideTitle;
  return handoffTitle ?? outsideTitle;
}

function compactOversizedLine(runtime: TranscriptRuntime, line: string): string | undefined {
  try {
    const entry = JSON.parse(line) as { type?: string; payload?: Record<string, unknown>; message?: Record<string, unknown> };
    if (runtime === "codex" && entry.type === "response_item" && entry.payload) {
      const payload = { ...entry.payload };
      if (typeof payload.output === "string") payload.output = `${payload.output.slice(0, 4000)}\n…[large output truncated by index]`;
      if (typeof payload.arguments === "string") payload.arguments = `${payload.arguments.slice(0, 4000)}\n…[large input truncated by index]`;
      return JSON.stringify({ ...entry, payload });
    }
    if (runtime === "claude" && entry.message) {
      return JSON.stringify({ ...entry, message: { ...entry.message, content: "[Large transcript record omitted from the on-screen index.]" } });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function indexLine(meta: StoredMetadata, lineBuffer: Buffer, offset: number, searchParts: string[]): void {
  if (lineBuffer.length === 0 || lineBuffer.length > MAX_INDEX_LINE_BYTES) return;
  const line = lineBuffer.toString("utf8");
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    let relevant = false;
    let searchText: string | null = null;
    if (meta.runtime === "claude") {
      if (entry.type === "ai-title") {
        const title = titleCandidate(typeof entry.aiTitle === "string" ? entry.aiTitle : null);
        if (title) {
          meta.title = title;
          meta.titleSource = "ai";
        }
      }
      if (entry.type === "user" || entry.type === "assistant") {
        relevant = true;
        searchText = contentText(entry.message?.content);
        if (!meta.title && entry.type === "user" && !entry.isMeta) {
          const title = titleCandidate(searchText);
          if (title) {
            meta.title = title;
            meta.titleSource = /<runtime-handoff\b/i.test(searchText ?? "") ? "handoff" : "prompt";
          }
        }
      }
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (usage && typeof usage === "object") {
        meta.tokenUsage.inputTokens += Number(usage.input_tokens ?? 0);
        meta.tokenUsage.outputTokens += Number(usage.output_tokens ?? 0);
        meta.tokenUsage.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens ?? 0);
        meta.tokenUsage.cacheReadInputTokens += Number(usage.cache_read_input_tokens ?? 0);
        meta.tokenUsage.totalTokens =
          meta.tokenUsage.inputTokens +
          meta.tokenUsage.outputTokens +
          meta.tokenUsage.cacheCreationInputTokens +
          meta.tokenUsage.cacheReadInputTokens;
      }
    } else {
      const payload = entry.payload;
      if (entry.type === "turn_context" && typeof payload?.model === "string") {
        meta.currentModel = payload.model;
      }
      if (
        entry.type === "response_item" &&
        payload?.type === "message" &&
        (payload.role === "user" || payload.role === "assistant")
      ) {
        relevant = true;
        searchText = contentText(payload.content);
        if (payload.role === "user" && searchText) searchText = stripDeveloperInstructions(searchText);
        if (!meta.title && payload.role === "user") {
          const title = titleCandidate(searchText);
          if (title) {
            meta.title = title;
            meta.titleSource = /<runtime-handoff\b/i.test(searchText ?? "") ? "handoff" : "prompt";
          }
        }
      } else if (entry.type === "event_msg" && (payload?.type === "user_message" || payload?.type === "agent_message")) {
        relevant = true;
        searchText = contentText(payload.message);
        if (payload.type === "user_message" && searchText) searchText = stripDeveloperInstructions(searchText);
        if (!meta.title && payload.type === "user_message") {
          const title = titleCandidate(searchText);
          if (title) {
            meta.title = title;
            meta.titleSource = /<runtime-handoff\b/i.test(searchText ?? "") ? "handoff" : "prompt";
          }
        }
      } else if (
        entry.type === "response_item" &&
        ["function_call", "custom_tool_call", "web_search_call", "function_call_output", "custom_tool_call_output"].includes(payload?.type)
      ) {
        relevant = true;
      }
      if (entry.type === "event_msg" && payload?.type === "token_count") {
        const usage = payload.info?.total_token_usage;
        const inputTokens = Number(usage?.input_tokens ?? 0);
        const outputTokens = Number(usage?.output_tokens ?? 0) + Number(usage?.reasoning_output_tokens ?? 0);
        const cacheReadInputTokens = Number(usage?.cache_read_input_tokens ?? usage?.cached_input_tokens ?? 0);
        const totalTokens = Number(usage?.total_tokens ?? 0) || inputTokens + outputTokens + cacheReadInputTokens;
        if (totalTokens >= meta.tokenUsage.totalTokens) {
          meta.tokenUsage = { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens, totalTokens };
        }
      }
    }

    if (relevant) {
      const record: OffsetRecord = { o: offset, l: lineBuffer.length };
      if (
        meta.runtime === "codex" &&
        (entry.payload?.type === "agent_message" ||
          (entry.payload?.type === "message" && entry.payload?.role === "assistant")) &&
        meta.currentModel
      ) {
        record.m = meta.currentModel;
      }
      if (lineBuffer.length > MAX_PAGE_LINE_BYTES) record.s = compactOversizedLine(meta.runtime, line);
      meta.offsets.push(record);
    }
    if (searchText && meta.searchBytes < SEARCH_TEXT_CAP) {
      const remaining = SEARCH_TEXT_CAP - meta.searchBytes;
      const addition = Buffer.from(`${searchText}\n`);
      const kept = addition.subarray(0, remaining);
      if (kept.length > 0) {
        searchParts.push(kept.toString("utf8"));
        meta.searchBytes += kept.length;
      }
    }
  } catch {
    // A single partial or malformed record must not poison the transcript.
  }
}

function resetIndex(meta: StoredMetadata): void {
  meta.indexedBytes = 0;
  meta.sourceBytes = 0;
  meta.mtimeMs = 0;
  meta.title = undefined;
  meta.titleSource = undefined;
  meta.tokenUsage = emptyUsage();
  meta.offsets = [];
  meta.recordCount = 0;
  meta.searchBytes = 0;
  meta.currentModel = undefined;
  try { unlinkSync(searchPath(meta.key)); } catch { /* absent */ }
}

async function ensureIndexedNow(key: string): Promise<StoredMetadata> {
  const registration = registrations.get(key);
  if (!registration?.path || !existsSync(registration.path)) throw new Error(`Transcript is unavailable: ${key}`);
  const resolved = registration as TranscriptRegistration & { path: string };
  const stat = statSync(resolved.path);
  const meta = readMetadata(resolved);
  if (stat.size < meta.indexedBytes) resetIndex(meta);
  if (stat.size === meta.indexedBytes && stat.mtimeMs === meta.mtimeMs) return meta;

  const fd = openSync(resolved.path, "r");
  const searchParts: string[] = [];
  let position = meta.indexedBytes;
  let lineOffset = position;
  let carry = Buffer.alloc(0);
  try {
    let chunksSinceYield = 0;
    while (position < stat.size) {
      const length = Math.min(READ_CHUNK_BYTES, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read <= 0) break;
      const bytes = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      for (let cursor = 0; cursor < bytes.length; cursor += 1) {
        if (bytes[cursor] !== 0x0a) continue;
        indexLine(meta, bytes.subarray(start, cursor), lineOffset, searchParts);
        lineOffset += cursor - start + 1;
        start = cursor + 1;
      }
      carry = Buffer.from(bytes.subarray(start));
      if (carry.length > MAX_INDEX_LINE_BYTES) {
        // Giant tool output has no useful searchable value and would otherwise
        // let one line monopolize the worker's heap. Drop it until its newline.
        carry = Buffer.alloc(0);
        lineOffset = position + read;
      }
      position += read;
      chunksSinceYield += 1;
      if (chunksSinceYield >= 8) {
        chunksSinceYield = 0;
        // Indexing an old multi-GB history must never monopolize the worker:
        // cursor-page and metadata requests get a chance to run between chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    closeSync(fd);
  }
  // Only complete newline-terminated records are committed. The next append
  // resumes at the beginning of a partial tail and finishes it exactly once.
  meta.indexedBytes = lineOffset;
  meta.sourceBytes = stat.size;
  meta.mtimeMs = stat.mtimeMs;
  meta.recordCount = meta.offsets.length;
  if (searchParts.length > 0) appendFileSync(searchPath(key), searchParts.join(""), { mode: 0o600 });
  writeJsonAtomic(metadataPath(key), meta);
  return meta;
}

function ensureIndexed(key: string): Promise<StoredMetadata> {
  const previous = jobs.get(key) ?? Promise.resolve(undefined as unknown as StoredMetadata);
  const next = previous.catch(() => undefined).then(() => ensureIndexedNow(key));
  jobs.set(key, next);
  return next.finally(() => {
    if (jobs.get(key) === next) jobs.delete(key);
  });
}

function publicMetadata(meta: StoredMetadata): TranscriptIndexMetadata {
  const { offsets: _offsets, searchBytes: _searchBytes, mtimeMs: _mtimeMs, version: _version, currentModel: _currentModel, ...value } = meta;
  return value;
}

async function page(key: string, beforeOffset: number | undefined, maxRecords: number): Promise<TranscriptIndexPage> {
  const registration = registrations.get(key);
  if (!registration?.path || !existsSync(registration.path)) throw new Error(`Transcript is unavailable: ${key}`);
  const resolved = registration as TranscriptRegistration & { path: string };
  const stat = statSync(resolved.path);
  const stored = readMetadata(resolved);
  // A historical transcript may be gigabytes. Do not make its first page wait
  // for a one-time forward index: read backwards to the requested cursor now,
  // then let the durable index catch up in this worker for future search/pages.
  if (stored.indexedBytes !== stat.size) {
    return rawPage(resolved, stored, stat.size, beforeOffset, maxRecords);
  }
  const meta = stored;
  let end = meta.offsets.length;
  if (beforeOffset !== undefined) {
    let low = 0;
    let high = meta.offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((meta.offsets[middle]?.o ?? 0) < beforeOffset) low = middle + 1;
      else high = middle;
    }
    end = low;
  }
  const start = Math.max(0, end - Math.max(1, maxRecords));
  const selected = meta.offsets.slice(start, end);
  const fd = openSync(meta.path, "r");
  try {
    const lines = selected.flatMap((record) => {
      if (record.s) return [{ offset: record.o, text: record.s, model: record.m }];
      if (record.l > MAX_PAGE_LINE_BYTES) return [];
      const buffer = Buffer.allocUnsafe(record.l);
      const read = readSync(fd, buffer, 0, record.l, record.o);
      return read > 0 ? [{ offset: record.o, text: buffer.subarray(0, read).toString("utf8"), model: record.m }] : [];
    });
    return {
      metadata: publicMetadata(meta),
      lines,
      beforeOffset: selected[0]?.o,
      hasEarlier: start > 0,
    };
  } finally {
    closeSync(fd);
  }
}

function rawRelevant(runtime: TranscriptRuntime, line: string): boolean {
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    if (runtime === "claude") return entry.type === "user" || entry.type === "assistant";
    const payload = entry.payload;
    return (
      (entry.type === "event_msg" && (payload?.type === "user_message" || payload?.type === "agent_message")) ||
      (entry.type === "response_item" &&
        payload?.type === "message" &&
        (payload.role === "user" || payload.role === "assistant")) ||
      (entry.type === "response_item" &&
        ["function_call", "custom_tool_call", "web_search_call", "function_call_output", "custom_tool_call_output"].includes(payload?.type))
    );
  } catch {
    return false;
  }
}

function updateRawMetadata(meta: StoredMetadata, line: string, offset: number, allowPromptTitle: boolean): void {
  if (offset < meta.indexedBytes) return;
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    if (meta.runtime === "claude") {
      if (entry.type === "ai-title") {
        const title = titleCandidate(typeof entry.aiTitle === "string" ? entry.aiTitle : null);
        if (title) {
          meta.title = title;
          meta.titleSource = "ai";
        }
      } else if (allowPromptTitle && !meta.title && entry.type === "user" && !entry.isMeta) {
        const title = titleCandidate(contentText(entry.message?.content));
        if (title) {
          meta.title = title;
          meta.titleSource = "prompt";
        }
      }
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (usage) {
        meta.tokenUsage.inputTokens += Number(usage.input_tokens ?? 0);
        meta.tokenUsage.outputTokens += Number(usage.output_tokens ?? 0);
        meta.tokenUsage.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens ?? 0);
        meta.tokenUsage.cacheReadInputTokens += Number(usage.cache_read_input_tokens ?? 0);
        meta.tokenUsage.totalTokens =
          meta.tokenUsage.inputTokens + meta.tokenUsage.outputTokens +
          meta.tokenUsage.cacheCreationInputTokens + meta.tokenUsage.cacheReadInputTokens;
      }
      return;
    }
    const payload = entry.payload;
    const userMessage =
      (entry.type === "event_msg" && payload?.type === "user_message") ||
      (entry.type === "response_item" && payload?.type === "message" && payload?.role === "user");
    if (allowPromptTitle && !meta.title && userMessage) {
      const raw = contentText(payload.message ?? payload.content);
      const title = titleCandidate(raw ? stripDeveloperInstructions(raw) : null);
      if (title) {
        meta.title = title;
        meta.titleSource = "prompt";
      }
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      const usage = payload.info?.total_token_usage;
      const inputTokens = Number(usage?.input_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? 0) + Number(usage?.reasoning_output_tokens ?? 0);
      const cacheReadInputTokens = Number(usage?.cache_read_input_tokens ?? usage?.cached_input_tokens ?? 0);
      const totalTokens = Number(usage?.total_tokens ?? 0) || inputTokens + outputTokens + cacheReadInputTokens;
      if (totalTokens >= meta.tokenUsage.totalTokens) {
        meta.tokenUsage = { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens, totalTokens };
      }
    }
  } catch {
    // Page content remains useful even when one metadata record is malformed.
  }
}

function rawPage(
  registration: TranscriptRegistration & { path: string },
  stored: StoredMetadata,
  sourceBytes: number,
  beforeOffset: number | undefined,
  maxRecords: number,
): TranscriptIndexPage {
  const end = Math.min(beforeOffset ?? sourceBytes, sourceBytes);
  let pageMetadata: StoredMetadata = { ...stored, tokenUsage: { ...stored.tokenUsage }, offsets: stored.offsets };
  const fd = openSync(registration.path, "r");
  let windowBytes = Math.min(4 * 1024 * 1024, Math.max(end, 1));
  let scannedStart = end;
  let lines: Array<{ offset: number; text: string; model?: string }> = [];
  try {
    while (true) {
      const candidateMetadata: StoredMetadata = { ...stored, tokenUsage: { ...stored.tokenUsage }, offsets: stored.offsets };
      const start = Math.max(0, end - windowBytes);
      scannedStart = start;
      const buffer = Buffer.allocUnsafe(end - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const bytes = buffer.subarray(0, read);
      const candidates: Array<{ offset: number; text: string; model?: string }> = [];
      let currentModel: string | undefined;
      let lineStart = 0;
      for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
        if (cursor !== bytes.length && bytes[cursor] !== 0x0a) continue;
        const fragment = start > 0 && lineStart === 0;
        if (!fragment && cursor > lineStart) {
          const raw = bytes.subarray(lineStart, cursor);
          const fullText = raw.toString("utf8");
          updateRawMetadata(candidateMetadata, fullText, start + lineStart, start === 0);
          let model: string | undefined;
          if (registration.runtime === "codex") {
            try {
              const entry = JSON.parse(fullText) as {
                type?: string;
                payload?: { type?: string; role?: string; model?: string };
              };
              if (entry.type === "turn_context" && entry.payload?.model) currentModel = entry.payload.model;
              if (
                (entry.type === "event_msg" && entry.payload?.type === "agent_message") ||
                (entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "assistant")
              ) model = currentModel;
            } catch {
              // rawRelevant below will reject the same malformed record.
            }
          }
          const text = raw.length > MAX_PAGE_LINE_BYTES
            ? compactOversizedLine(registration.runtime, fullText)
            : fullText;
          if (text && rawRelevant(registration.runtime, text)) candidates.push({ offset: start + lineStart, text, model });
        }
        lineStart = cursor + 1;
      }
      lines = candidates.slice(-maxRecords);
      pageMetadata = candidateMetadata;
      if (lines.length >= maxRecords || start === 0 || windowBytes >= 128 * 1024 * 1024) break;
      windowBytes = Math.min(end, windowBytes * 2);
    }
  } finally {
    closeSync(fd);
  }
  const earliest = lines[0]?.offset;
  const hasEarlier = earliest !== undefined ? earliest > 0 : scannedStart > 0;
  return {
    metadata: { ...publicMetadata(pageMetadata), sourceBytes },
    lines,
    // A sparse transcript can contain no displayable records in the scanned
    // window. Still advance the byte cursor so the next request cannot loop on
    // the same 128 MB forever.
    beforeOffset: earliest ?? (hasEarlier ? scannedStart : undefined),
    hasEarlier,
  };
}

function snippetHit(document: TranscriptIndexSearchDocument, query: string): TranscriptIndexSearchHit | null {
  try {
    const text = readFileSync(searchPath(document.key), "utf8");
    const matchIndex = text.toLocaleLowerCase().indexOf(query);
    return matchIndex >= 0 ? { ...document, text, matchIndex } : null;
  } catch {
    return null;
  }
}

async function search(query: string, documents: TranscriptIndexSearchDocument[], limit: number): Promise<TranscriptIndexSearchHit[]> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const hits: TranscriptIndexSearchHit[] = [];
  for (const document of documents) {
    if (hits.length >= limit) break;
    try { await ensureIndexed(document.key); } catch { continue; }
    const hit = snippetHit(document, normalized);
    if (hit) hits.push(hit);
  }
  return hits;
}

function resolveCodexRegistrations(incoming: TranscriptRegistration[]): void {
  for (const registration of incoming) {
    const existing = registrations.get(registration.key);
    if (!registration.path && existing?.path) registration.path = existing.path;
  }
  const unresolved = new Map(
    incoming.filter((entry) => entry.runtime === "codex" && !entry.path && entry.codexThreadId).map((entry) => [entry.codexThreadId!, entry]),
  );
  if (unresolved.size === 0) return;
  if (!config) throw new Error("Transcript index worker is not configured.");
  const roots = [join(config.home, ".codex", "sessions"), join(config.home, ".codex", "archived_sessions")];
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0 && unresolved.size > 0) {
      const directory = stack.pop();
      if (!directory) continue;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          for (const [threadId, registration] of unresolved) {
            if (!entry.name.includes(threadId)) continue;
            registration.path = path;
            unresolved.delete(threadId);
            break;
          }
        }
      }
    }
  }
}

export async function handleTranscriptIndexRequest(request: TranscriptIndexWorkerRequest): Promise<unknown> {
  if (request.type === "register") {
    resolveCodexRegistrations(request.registrations);
    for (const registration of request.registrations) registrations.set(registration.key, registration);
    return request.registrations.map((registration) => ({ key: registration.key, path: registration.path }));
  }
  if (request.type === "page") return page(request.key, request.beforeOffset, request.maxRecords);
  if (request.type === "metadata" || request.type === "refresh") return publicMetadata(await ensureIndexed(request.key));
  return search(request.query, request.documents, request.limit);
}

export function configureTranscriptIndexForTest(next: WorkerConfig): void {
  config = next;
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  registrations.clear();
  jobs.clear();
}

const port = parentPort;
if (port) port.on("message", (request: TranscriptIndexWorkerRequest) => {
  void handleTranscriptIndexRequest(request).then(
    (value) => port.postMessage({ id: request.id, ok: true, value } satisfies TranscriptIndexWorkerResponse),
    (error) => port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies TranscriptIndexWorkerResponse),
  );
});
