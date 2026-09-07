import type { TokenUsageStats } from "./ipc";

export type TranscriptRuntime = "claude" | "codex";

export type TranscriptRegistration = {
  key: string;
  runtime: TranscriptRuntime;
  path?: string;
  codexThreadId?: string;
};

export type TranscriptIndexMetadata = {
  key: string;
  path: string;
  runtime: TranscriptRuntime;
  indexedBytes: number;
  sourceBytes: number;
  title?: string;
  titleSource?: "ai" | "prompt" | "handoff";
  tokenUsage: TokenUsageStats;
  recordCount: number;
};

export type TranscriptIndexedLine = {
  offset: number;
  text: string;
  /** Active model captured from the preceding Codex turn_context record. */
  model?: string;
};

export type TranscriptIndexPage = {
  metadata: TranscriptIndexMetadata;
  lines: TranscriptIndexedLine[];
  beforeOffset?: number;
  hasEarlier: boolean;
};

export type TranscriptIndexSearchDocument = {
  key: string;
  id: string;
  title: string;
  workspaceName: string;
};

export type TranscriptIndexSearchHit = {
  id: string;
  title: string;
  workspaceName: string;
  text: string;
  matchIndex: number;
};

export type TranscriptIndexWorkerRequest =
  | { id: number; type: "register"; registrations: TranscriptRegistration[] }
  | { id: number; type: "page"; key: string; beforeOffset?: number; maxRecords: number }
  | { id: number; type: "metadata"; key: string }
  | { id: number; type: "refresh"; key: string }
  | { id: number; type: "search"; query: string; documents: TranscriptIndexSearchDocument[]; limit: number };

export type TranscriptIndexWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
