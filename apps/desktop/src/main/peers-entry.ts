import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersistedThread } from "../shared/ipc";
import {
  parseTurns,
  renderPeerDetail,
  renderPeerList,
  selectWorkspacePeers,
  summarizePeer,
  type PeerSession,
} from "../shared/workspace-peers";

/**
 * The agent-facing half of workspace awareness.
 *
 * This file is a SECOND entry point of the main bundle, not part of the app: it
 * is spawned per session as an MCP server (Claude reaches it through
 * `--mcp-config`) and can also be run one-shot from a shell (`panda-peers`,
 * which is how Codex and plain terminal sections reach it, since neither takes
 * MCP servers from us without editing the user's own config).
 *
 * It deliberately talks to disk rather than to the running app: no port, no
 * token, no lifecycle to get wrong, and it keeps working while the desktop is
 * busy. `threads.json` is written by the renderer on every state change, so the
 * snapshot it reads is at most one UI tick old.
 *
 * Nothing here may import `electron` — the process is Node (Electron started
 * with ELECTRON_RUN_AS_NODE=1), so there is no app object to ask for paths.
 */

const MCP_PROTOCOL_VERSION = "2024-11-05";
/** Matches the `mcpServers` key the main process writes into `--mcp-config`. */
const SERVER_NAME = "panda_workspace";

type Options = {
  threadsPath: string;
  cwd: string;
  selfId?: string;
  home: string;
};

/** Flags that take a value; everything else is a bare switch or a positional. */
const VALUE_FLAGS = new Set(["threads", "cwd", "self", "home"]);

type ParsedArgv = { options: Options; positionals: string[]; switches: Set<string> };

function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (VALUE_FLAGS.has(name)) {
      flags.set(name, argv[index + 1] ?? "");
      index += 1;
    } else {
      switches.add(name);
    }
  }

  return {
    options: {
      threadsPath: flags.get("threads") ?? process.env.PANDA_CODE_THREADS ?? "",
      // Defaulting to the process cwd is what makes the shell form work with no
      // arguments: a tool call runs in the section's workspace.
      cwd: flags.get("cwd") ?? process.env.PANDA_CODE_WORKSPACE ?? process.cwd(),
      selfId: flags.get("self") ?? process.env.PANDA_CODE_SECTION_ID ?? undefined,
      home: flags.get("home") ?? process.env.PANDA_CODE_HOME ?? homedir(),
    },
    positionals,
    switches,
  };
}

function readThreads(threadsPath: string): PersistedThread[] {
  try {
    const parsed = JSON.parse(readFileSync(threadsPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PersistedThread[]) : [];
  } catch {
    return [];
  }
}

/**
 * Same encoding the Claude CLI uses for its project directories: every
 * non-alphanumeric character becomes "-". Kept in sync with `claudeProjectDir`
 * in the main process.
 */
function claudeTranscriptPath(home: string, cwd: string, claudeSessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${claudeSessionId}.jsonl`);
}

/** Codex files its sessions under dated directories, so the id has to be hunted. */
function codexTranscriptPath(home: string, codexThreadId: string): string | null {
  const roots = [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      if (!directory) {
        continue;
      }

      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const path = join(directory, entry);
        if (entry.endsWith(".jsonl") && entry.includes(codexThreadId)) {
          return path;
        }

        try {
          if (statSync(path).isDirectory()) {
            stack.push(path);
          }
        } catch {
          // Raced with a rotation; the remaining candidates still stand.
        }
      }
    }
  }

  return null;
}

/** Transcripts run long; only the tail says what a section is doing now. */
const TAIL_BYTES = 200_000;

function readTranscript(thread: PersistedThread, options: Options): string | undefined {
  const runtime = thread.runtime ?? "claude";
  const path =
    runtime === "codex"
      ? thread.codexThreadId
        ? codexTranscriptPath(options.home, thread.codexThreadId)
        : null
      : thread.claudeSessionId
        ? claudeTranscriptPath(options.home, thread.cwd, thread.claudeSessionId)
        : null;

  if (!path || !existsSync(path)) {
    return undefined;
  }

  try {
    const text = readFileSync(path, "utf8");
    return text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
  } catch {
    return undefined;
  }
}

function listPeers(options: Options, includeSelf: boolean): { peers: PeerSession[]; text: string } {
  const threads = selectWorkspacePeers(readThreads(options.threadsPath), {
    cwd: options.cwd,
    selfId: options.selfId,
    includeSelf,
  });

  const peers = threads.map((thread) => summarizePeer(thread, { selfId: options.selfId, transcript: readTranscript(thread, options) }));
  return { peers, text: renderPeerList(peers, options.cwd) };
}

/** Ids are long; matching a title prefix too makes the tool usable by hand. */
function findThread(options: Options, idOrTitle: string): PersistedThread | undefined {
  const threads = selectWorkspacePeers(readThreads(options.threadsPath), { cwd: options.cwd, selfId: options.selfId });
  const needle = idOrTitle.trim().toLowerCase();
  return (
    threads.find((thread) => thread.id.toLowerCase() === needle) ??
    threads.find((thread) => thread.title.toLowerCase() === needle) ??
    threads.find((thread) => thread.title.toLowerCase().includes(needle))
  );
}

function readPeer(options: Options, idOrTitle: string, limit: number): string {
  const thread = findThread(options, idOrTitle);
  if (!thread) {
    return `No section matching "${idOrTitle}" is open in ${options.cwd}. Call list_sessions first.`;
  }

  const transcript = readTranscript(thread, options);
  const peer = summarizePeer(thread, { selfId: options.selfId, transcript });
  const turns = transcript ? parseTurns(thread.runtime ?? "claude", transcript, limit) : [];
  return renderPeerDetail(peer, turns);
}

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "List the other Panda Code sections (agent sessions) open in this workspace, with what each one is doing right now and an excerpt of its latest exchange. Use it before starting work that another section may already be doing, or when the user refers to work you did not do.",
    inputSchema: {
      type: "object",
      properties: {
        includeSelf: { type: "boolean", description: "Include this section in the list. Defaults to false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_session",
    description:
      "Read the recent conversation of one section in this workspace, by the id or title from list_sessions. Use it to pick up context from a neighbouring agent's work.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Section id, or a title fragment." },
        limit: { type: "number", description: "How many recent turns to return. Defaults to 12." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

type JsonRpcRequest = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

function callTool(options: Options, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_sessions":
      return listPeers(options, args.includeSelf === true).text;
    case "read_session": {
      const id = typeof args.id === "string" ? args.id : "";
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 12;
      return id ? readPeer(options, id, limit) : "read_session needs an `id`. Call list_sessions first.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

function runMcpServer(options: Options): void {
  const write = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const handle = (request: JsonRpcRequest): void => {
    const { id, method } = request;
    // Notifications (no id) need no reply — `notifications/initialized` is the
    // only one the client sends us.
    if (id === undefined || id === null) {
      return;
    }

    switch (method) {
      case "initialize":
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: "1.0.0" },
          },
        });
        return;
      case "tools/list":
        write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const params = request.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: callTool(options, name, args) }] } });
        } catch (error) {
          write({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Workspace lookup failed: ${String(error)}` }], isError: true },
          });
        }
        return;
      }
      default:
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        handle(JSON.parse(line) as JsonRpcRequest);
      } catch {
        // A malformed frame is not worth killing the server over.
      }
    }
  });
  process.stdin.on("close", () => process.exit(0));
}

function main(): void {
  const { options, positionals, switches } = parseArgv(process.argv.slice(2));

  if (switches.has("mcp")) {
    runMcpServer(options);
    return;
  }

  const [command, target] = positionals;
  if (command === "show" || command === "read") {
    process.stdout.write(`${readPeer(options, target ?? "", 12)}\n`);
    return;
  }

  process.stdout.write(`${listPeers(options, switches.has("with-self")).text}\n`);
}

main();
