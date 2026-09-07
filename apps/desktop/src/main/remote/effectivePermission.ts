import type { AgentRuntime, SessionStartRequest } from "../../shared/ipc";

/** Split a launcher command without executing it, preserving quoted arguments. */
export function tokenizeLaunchCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function permissionFromArgs(tokens: string[], startIndex: number): { present: boolean; mode?: string } {
  let mode: string | undefined;
  let present = false;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--dangerously-skip-permissions" || token === "--allow-dangerously-skip-permissions") {
      // The latter enables entering bypass mode later. Capability to become
      // unrestricted is unrestricted for the phone-access ceiling.
      return { present: true, mode: "bypassPermissions" };
    }
    if (token === "--permission-mode") {
      present = true;
      const next = tokens[index + 1];
      if (next && !next.startsWith("-")) {
        mode = next.trim() || undefined;
        index += 1;
      } else {
        mode = undefined;
      }
    } else if (token?.startsWith("--permission-mode=")) {
      present = true;
      mode = token.slice("--permission-mode=".length).trim() || undefined;
    }
  }
  return { present, mode };
}

function explicitClaudePermission(command: string): { present: boolean; mode?: string } {
  return permissionFromArgs(tokenizeLaunchCommand(command), 1);
}

/** Resolve authority from the final argv handed to Claude, not the source text. */
export function effectiveClaudePermissionFromArgs(args: string[]): string | undefined {
  return permissionFromArgs(args, 0).mode;
}

/**
 * The single permission decision used both to append Claude launch arguments
 * and to authorize later remote delivery. Keeping the appended args beside the
 * effective result prevents the two paths from interpreting quoting differently.
 */
export function resolveClaudeLaunchPermission(command: string, savedPermissionMode?: string): {
  commandHasPermissionOverride: boolean;
  effectivePermissionMode: string | undefined;
  appendedArgs: string[];
} {
  const explicit = explicitClaudePermission(command);
  if (explicit.present) {
    return {
      commandHasPermissionOverride: true,
      effectivePermissionMode: explicit.mode,
      appendedArgs: [],
    };
  }

  const saved = savedPermissionMode?.trim() || undefined;
  return {
    commandHasPermissionOverride: false,
    effectivePermissionMode: saved,
    appendedArgs: !saved
      ? []
      : saved === "bypassPermissions"
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", saved],
  };
}

/**
 * Resolve the authority of an existing or resumable session for remote use.
 * Claude command flags outrank the saved selector because they outrank it at
 * launch. Codex without an explicit sandbox remains unknown and therefore must
 * fail closed: local Codex configuration may resolve that omission differently.
 */
export function effectiveRemotePermission(request: SessionStartRequest): {
  runtime: AgentRuntime;
  permissionMode: string | undefined;
} {
  const runtime = request.runtime ?? "claude";
  if (runtime === "groq") return { runtime, permissionMode: undefined };
  if (runtime === "codex") return { runtime, permissionMode: request.permissionMode?.trim() || undefined };
  const launch = resolveClaudeLaunchPermission(request.command, request.permissionMode);
  // The old launcher used a raw-text flag check, so quoted flags could coexist
  // with appended saved args. Keep the more powerful possibility for every
  // existing/restored request instead of trusting provenance we cannot prove.
  const saved = request.permissionMode?.trim() || undefined;
  const legacyPermission = saved === "bypassPermissions" || launch.effectivePermissionMode === "bypassPermissions"
    ? "bypassPermissions"
    : launch.commandHasPermissionOverride
      ? launch.effectivePermissionMode
      : saved;
  return {
    runtime,
    permissionMode: legacyPermission,
  };
}
