import 'dart:convert';
import 'dart:typed_data';

// Wire models — mirror convex-relay/convex/schema.ts and the desktop's ipc.ts.
// Content fields (title, body, tool, runtime) arrive as ciphertext and are
// decrypted before constructing these. The tool/thinking/runtime fields are
// OPTIONAL, backward-compatible extensions (docs/protocol.md §4): when absent we
// degrade gracefully to title/body so an older desktop still renders.

enum SessionStatus { idle, running, exited, error }

enum AgentState { working, waiting, needsAction, exited }

enum AgentRuntime { claude, codex }

String agentRuntimeWireValue(AgentRuntime runtime) => switch (runtime) {
      AgentRuntime.claude => 'claude',
      AgentRuntime.codex => 'codex',
    };

AgentRuntime agentRuntimeFrom(String? value) =>
    value?.trim() == 'codex' ? AgentRuntime.codex : AgentRuntime.claude;

String agentRuntimeLabel(AgentRuntime runtime) => switch (runtime) {
      AgentRuntime.claude => 'Claude',
      AgentRuntime.codex => 'Codex',
    };

SessionStatus sessionStatusFrom(String s) => switch (s) {
      'running' => SessionStatus.running,
      'exited' => SessionStatus.exited,
      'error' => SessionStatus.error,
      _ => SessionStatus.idle,
    };

AgentState agentStateFrom(String s) => switch (s) {
      'working' => AgentState.working,
      'waiting' => AgentState.waiting,
      'needs_action' => AgentState.needsAction,
      _ => AgentState.exited,
    };

class LaunchOption {
  final String value;
  final String label;
  final String hint;
  final String? badge;

  const LaunchOption({
    required this.value,
    required this.label,
    required this.hint,
    this.badge,
  });
}

const claudeModelOptions = <LaunchOption>[
  LaunchOption(
      value: '',
      label: 'Default',
      hint: 'Use the Claude Code default',
      badge: 'Default'),
  LaunchOption(
      value: 'sonnet',
      label: 'Sonnet',
      hint: 'Balanced coding and reviews',
      badge: 'Balanced'),
  LaunchOption(
      value: 'opus',
      label: 'Opus',
      hint: 'Hard reasoning and refactors',
      badge: 'Deep'),
  LaunchOption(
      value: 'best',
      label: 'Best available',
      hint: 'Automatically picks the strongest available model',
      badge: 'Auto'),
  LaunchOption(
      value: 'fable',
      label: 'Fable',
      hint: 'Long-running autonomous work',
      badge: 'Max'),
  LaunchOption(
      value: 'opusplan',
      label: 'Opus plan',
      hint: 'Opus planning with Sonnet execution',
      badge: 'Plan'),
  LaunchOption(
      value: 'sonnet[1m]',
      label: 'Sonnet 1M',
      hint: 'Long-context Sonnet sessions',
      badge: '1M'),
  LaunchOption(
      value: 'opus[1m]',
      label: 'Opus 1M',
      hint: 'Long-context Opus sessions',
      badge: '1M'),
  LaunchOption(
      value: 'haiku',
      label: 'Haiku',
      hint: 'Fast simple checks',
      badge: 'Fast'),
];

const codexModelOptions = <LaunchOption>[
  LaunchOption(
      value: '',
      label: 'Default',
      hint: 'Use the Codex CLI default',
      badge: 'Default'),
  LaunchOption(
      value: 'codex-auto-review',
      label: 'Auto Review',
      hint: 'Managed review-style coding'),
];

const claudeEffortOptions = <LaunchOption>[
  LaunchOption(
      value: '', label: 'Default', hint: 'Use your Claude Code default'),
  LaunchOption(value: 'low', label: 'Low', hint: 'Fastest, minimal reasoning'),
  LaunchOption(value: 'medium', label: 'Medium', hint: 'Light reasoning'),
  LaunchOption(value: 'high', label: 'High', hint: 'Standard reasoning'),
  LaunchOption(value: 'xhigh', label: 'X-High', hint: 'Deep reasoning'),
  LaunchOption(value: 'max', label: 'Max', hint: 'Deepest reasoning'),
];

const codexEffortOptions = <LaunchOption>[
  LaunchOption(
      value: '', label: 'Default', hint: 'Use your Codex default reasoning'),
  LaunchOption(
      value: 'minimal', label: 'Minimal', hint: 'Small mechanical tasks'),
  LaunchOption(value: 'low', label: 'Low', hint: 'Quick scoped work'),
  LaunchOption(value: 'medium', label: 'Medium', hint: 'Balanced planning'),
  LaunchOption(value: 'high', label: 'High', hint: 'Deeper reasoning'),
  LaunchOption(value: 'xhigh', label: 'X-High', hint: 'Hard multi-step work'),
];

const claudePermissionOptions = <LaunchOption>[
  LaunchOption(
      value: '',
      label: 'Ask',
      hint: 'Use your Claude Code permission settings'),
  LaunchOption(
      value: 'acceptEdits',
      label: 'Accept edits',
      hint: 'Auto-approve workspace edits'),
  LaunchOption(value: 'plan', label: 'Plan', hint: 'Read-only planning'),
  LaunchOption(
      value: 'bypassPermissions',
      label: 'Full access',
      hint: 'Bypass all permission checks — confirmed with Face ID'),
];

const codexSandboxOptions = <LaunchOption>[
  LaunchOption(
      value: 'read-only',
      label: 'Read-only',
      hint: 'Inspect files without edits'),
  LaunchOption(
      value: 'workspace-write',
      label: 'Workspace write',
      hint: 'Allow edits inside the workspace'),
  LaunchOption(
      value: 'danger-full-access',
      label: 'Full access',
      hint: 'No sandbox — confirmed with Face ID'),
];

/// Permission modes that grant unrestricted access and therefore require an
/// extra Face ID confirmation before a session can start.
const fullAccessPermissionModes = <String>{
  'bypassPermissions',
  'danger-full-access',
};

bool isFullAccessPermissionMode(String? mode) =>
    fullAccessPermissionModes.contains(mode?.trim());

List<LaunchOption> modelOptionsFor(AgentRuntime runtime) =>
    runtime == AgentRuntime.codex ? codexModelOptions : claudeModelOptions;

List<LaunchOption> effortOptionsFor(AgentRuntime runtime) =>
    runtime == AgentRuntime.codex ? codexEffortOptions : claudeEffortOptions;

List<LaunchOption> permissionOptionsFor(AgentRuntime runtime) =>
    runtime == AgentRuntime.codex
        ? codexSandboxOptions
        : claudePermissionOptions;

String launchOptionLabel(
    List<LaunchOption> options, String? value, String fallback) {
  final trimmed = value?.trim() ?? '';
  return options
      .firstWhere(
        (option) => option.value == trimmed,
        orElse: () => LaunchOption(
            value: trimmed,
            label: trimmed.isEmpty ? fallback : trimmed,
            hint: ''),
      )
      .label;
}

bool isScratchWorkspacePath(String? path) {
  final parts =
      (path ?? '').split('/').where((part) => part.isNotEmpty).toList();
  if (parts.length < 2) return false;
  return parts[parts.length - 2] == '.panda-code' && parts.last == 'scratch';
}

String workspaceDisplayName(String? path, {String fallback = 'Other'}) {
  final dir = path?.trim() ?? '';
  if (dir.isEmpty) return fallback;
  if (isScratchWorkspacePath(dir)) return 'No project';
  final parts = dir.split('/').where((part) => part.isNotEmpty).toList();
  return parts.isEmpty ? dir : parts.last;
}

class SessionLaunchConfig {
  final String cwd;
  final AgentRuntime runtime;
  final String? model;
  final String? effort;
  final String? permissionMode;

  const SessionLaunchConfig({
    required this.cwd,
    required this.runtime,
    this.model,
    this.effort,
    this.permissionMode,
  });

  String get displayModel =>
      launchOptionLabel(modelOptionsFor(runtime), model, 'Default');

  /// The `start` command body. [prompt]/[images] ride along so the desktop
  /// starts the session AND runs its first turn from one command: a session that
  /// exists but has never been prompted reads as busy-with-nothing on both
  /// surfaces, which is exactly the state the draft route exists to avoid.
  Map<String, dynamic> toStartPayload(
    String id, {
    String prompt = '',
    List<ConversationImage> images = const [],
  }) =>
      {
        'id': id,
        'cwd': cwd,
        'runtime': agentRuntimeWireValue(runtime),
        if ((model ?? '').trim().isNotEmpty) 'model': model!.trim(),
        if ((effort ?? '').trim().isNotEmpty) 'effort': effort!.trim(),
        if ((permissionMode ?? '').trim().isNotEmpty)
          'permissionMode': permissionMode!.trim(),
        if (prompt.trim().isNotEmpty) 'prompt': prompt.trim(),
        if (images.isNotEmpty)
          'attachments': images.map((image) => image.toPayload()).toList(),
      };
}

/// An uncommitted session: launch settings plus a first prompt, with no session
/// id, no relay row and no process anywhere. Becomes a real session only when
/// it's sent — until then it can be abandoned for free, which is the whole point
/// of the draft route.
///
/// [workspacePath] is a path rather than a WorkspaceOption so this stays free of
/// widget-layer types; the route resolves it against the live workspace list.
class SessionDraft {
  final String? workspacePath;
  final AgentRuntime runtime;
  final String model;
  final String customModel;
  final String effort;
  final String permissionMode;
  final String prompt;
  final List<ConversationImage> images;

  const SessionDraft({
    this.workspacePath,
    this.runtime = AgentRuntime.claude,
    this.model = '',
    this.customModel = '',
    this.effort = '',
    this.permissionMode = '',
    this.prompt = '',
    this.images = const [],
  });

  /// True when there is something a user would be annoyed to lose.
  bool get hasContent =>
      prompt.trim().isNotEmpty || images.isNotEmpty || customModel.isNotEmpty;

  /// The typed custom model wins over the picked one — it's the more specific
  /// intent, and the form clears the other whenever either changes.
  String get effectiveModel =>
      customModel.trim().isNotEmpty ? customModel.trim() : model;

  SessionLaunchConfig? toConfig() {
    final cwd = workspacePath;
    if (cwd == null || cwd.isEmpty) return null;
    return SessionLaunchConfig(
      cwd: cwd,
      runtime: runtime,
      model: effectiveModel,
      effort: effort,
      permissionMode: permissionMode,
    );
  }

  SessionDraft copyWith({
    String? workspacePath,
    AgentRuntime? runtime,
    String? model,
    String? customModel,
    String? effort,
    String? permissionMode,
    String? prompt,
    List<ConversationImage>? images,
  }) =>
      SessionDraft(
        workspacePath: workspacePath ?? this.workspacePath,
        runtime: runtime ?? this.runtime,
        model: model ?? this.model,
        customModel: customModel ?? this.customModel,
        effort: effort ?? this.effort,
        permissionMode: permissionMode ?? this.permissionMode,
        prompt: prompt ?? this.prompt,
        images: images ?? this.images,
      );

  /// Switching runtime resets everything runtime-shaped (a Claude model name is
  /// meaningless to Codex) while keeping the workspace and the typed prompt.
  SessionDraft withRuntime(AgentRuntime next) => SessionDraft(
        workspacePath: workspacePath,
        runtime: next,
        permissionMode: defaultPermissionModeForRuntime(next),
        prompt: prompt,
        images: images,
      );
}

/// The permission mode a runtime starts a fresh draft on.
String defaultPermissionModeForRuntime(AgentRuntime runtime) =>
    runtime == AgentRuntime.codex ? 'read-only' : 'bypassPermissions';

class ConversationImage {
  /// Stable, filename-safe id minted when the image is attached. Rides the send
  /// payload and, crucially, becomes the desktop's saved-file stem — so it shows
  /// up in the round-tripped message body path and lets us re-hydrate the bytes
  /// from the on-device cache on reload (see RemoteImageStore).
  final String id;
  final String name;
  final String mimeType;
  final Uint8List bytes;

  const ConversationImage({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  Map<String, dynamic> toPayload() => {
        'id': id,
        'name': name,
        'mimeType': mimeType,
        'data': base64Encode(bytes),
      };
}

/// High-level tool categories used to pick an icon and layout.
enum ToolCategory { bash, edit, read, search, web, task, other }

ToolCategory toolCategoryFrom(String? s, String? name) {
  switch (s) {
    case 'bash':
      return ToolCategory.bash;
    case 'edit':
      return ToolCategory.edit;
    case 'read':
      return ToolCategory.read;
    case 'search':
      return ToolCategory.search;
    case 'web':
      return ToolCategory.web;
    case 'task':
      return ToolCategory.task;
  }
  // Heuristic fallback from the tool name if the desktop didn't categorize.
  final n = (name ?? '').toLowerCase();
  if (n.contains('bash') || n.contains('shell') || n.contains('exec')) {
    return ToolCategory.bash;
  }
  if (n.contains('edit') || n.contains('write') || n.contains('patch')) {
    return ToolCategory.edit;
  }
  if (n.contains('read') || n.contains('cat')) return ToolCategory.read;
  if (n.contains('grep') ||
      n.contains('search') ||
      n.contains('glob') ||
      n.contains('find')) {
    return ToolCategory.search;
  }
  if (n.contains('web') || n.contains('fetch') || n.contains('http')) {
    return ToolCategory.web;
  }
  if (n.contains('task') || n.contains('agent')) return ToolCategory.task;
  return ToolCategory.other;
}

enum ToolStatus { running, success, error, unknown }

ToolStatus toolStatusFrom(String? s) => switch (s) {
      'running' => ToolStatus.running,
      'success' => ToolStatus.success,
      'error' => ToolStatus.error,
      _ => ToolStatus.unknown,
    };

/// Structured tool-call payload (docs/protocol.md §4). All fields optional.
class ToolData {
  final String name;
  final ToolCategory category;
  final ToolStatus status;
  final String? command; // bash
  final String? filePath; // edit / read
  final String? diff; // unified diff for edits
  final String? input; // generic input to display
  final String? output; // result / stdout
  final int? exitCode;

  const ToolData({
    required this.name,
    required this.category,
    required this.status,
    this.command,
    this.filePath,
    this.diff,
    this.input,
    this.output,
    this.exitCode,
  });

  /// Structured payload path (docs/protocol.md §4) — used when a newer desktop
  /// sends a `tool` object. Returns null so the caller can fall back to
  /// [synthesize] for the current wire shape (kind:"tool" + title + body).
  static ToolData? tryParse(Map<String, dynamic> json) {
    final raw = json['tool'];
    if (raw is! Map) return null;
    final m = Map<String, dynamic>.from(raw);
    final name = (m['name'] as String?) ?? (json['title'] as String?) ?? 'tool';
    return ToolData(
      name: name,
      category: toolCategoryFrom(m['category'] as String?, name),
      status: toolStatusFrom(m['status'] as String?),
      command: m['command'] as String?,
      filePath: m['filePath'] as String?,
      diff: m['diff'] as String?,
      input: m['input'] as String?,
      output: m['output'] as String?,
      exitCode: (m['exitCode'] as num?)?.toInt(),
    );
  }

  /// Builds tool data from what the desktop actually streams today: a
  /// `kind:"tool"` item carrying the tool name in [title] and a markdown [body]
  /// (the desktop's `toolInputBody`/`toolResultBody` output). A tool call and its
  /// result arrive as two separate items — [mergeToolResults] later folds the
  /// result's output back into the call so they render as one card.
  static ToolData synthesize({
    required String title,
    required String body,
    required bool isResult,
  }) {
    final name = title.trim().isEmpty ? 'Tool' : title.trim();
    final category = toolCategoryFrom(null, name);
    final trimmed = body.trim();
    if (isResult) {
      return ToolData(
        name: name,
        category: category,
        status: ToolStatus.success,
        output: trimmed.isEmpty ? null : trimmed,
      );
    }
    // A tool call. The desktop packs the interesting field (command / file path /
    // description / JSON args) into the body; split it so the card can show a
    // scannable target and highlight the input appropriately.
    final singleLine = !trimmed.contains('\n');
    final looksLikePath = singleLine &&
        !trimmed.contains(' ') &&
        (trimmed.startsWith('/') ||
            trimmed.startsWith('~') ||
            trimmed.startsWith('./') ||
            RegExp(r'^[\w./-]+\.[\w]+$').hasMatch(trimmed));
    String? command;
    String? filePath;
    String? input;
    if (category == ToolCategory.bash) {
      command = trimmed.isEmpty ? null : trimmed;
    } else if ((category == ToolCategory.edit ||
            category == ToolCategory.read) &&
        looksLikePath) {
      filePath = trimmed;
    } else {
      input = trimmed.isEmpty ? null : trimmed;
    }
    return ToolData(
      name: name,
      category: category,
      // A bare call has no known outcome yet (no chip). It flips to success once
      // its result is folded in; leaving it "running" would strand a spinner on
      // every already-finished call replayed from history.
      status: ToolStatus.unknown,
      command: command,
      filePath: filePath,
      input: input,
    );
  }

  /// Returns a copy with the tool's result [output] attached and the status
  /// resolved to success (used when folding a tool_result into its tool_use).
  ToolData withOutput(String? resultOutput) => ToolData(
        name: name,
        category: category,
        status: ToolStatus.success,
        command: command,
        filePath: filePath,
        diff: diff,
        input: input,
        output: resultOutput ?? output,
        exitCode: exitCode,
      );
}

/// Parses a stream-json conversation item id into its tool-call identity. Ids are
/// minted by the desktop's stream-json parser as `stream:<toolUseId>:tool` for a
/// call and `stream:<toolUseId>:result` for its result, so a shared `<toolUseId>`
/// lets [mergeToolResults] pair them.
({String uid, bool isResult})? toolIdParts(String id) {
  final m = RegExp(r'^stream:(.+):(tool|result)$').firstMatch(id);
  if (m == null) return null;
  return (uid: m.group(1)!, isResult: m.group(2) == 'result');
}

/// True for the end-of-turn stats footer the desktop emits as a `system` item
/// anchored to the turn's final assistant message (`stream:<id>:summary`). Both
/// clients detect it by id + kind and render it as a caption, not a system line.
bool isTurnSummaryItem(ConversationItem item) =>
    item.kind == 'system' &&
    item.id.startsWith('stream:') &&
    item.id.endsWith(':summary');

/// Folds each tool_result item into the tool_use it belongs to, so a call and
/// its output render as a single card instead of two stray log lines. A result
/// with no surviving call (e.g. its call paged out of history) is kept as its
/// own item. Non-tool items pass through untouched and in order.
List<ConversationItem> mergeToolResults(List<ConversationItem> items) {
  final out = <ConversationItem>[];
  final callIndexByUid = <String, int>{};
  for (final item in items) {
    final parts = item.tool != null ? toolIdParts(item.id) : null;
    if (parts != null && parts.isResult) {
      final at = callIndexByUid[parts.uid];
      if (at != null) {
        final call = out[at];
        out[at] = call.copyWith(tool: call.tool!.withOutput(item.tool!.output));
        continue;
      }
    }
    if (parts != null && !parts.isResult) {
      callIndexByUid[parts.uid] = out.length;
    }
    out.add(item);
  }
  return out;
}

/// One backward page of history from `sessions:history`. [items] are ascending
/// by sequence; [nextBeforeSeq] is the cursor for the next-older page (null when
/// [isDone]).
class HistoryPage {
  final List<ConversationItem> items;
  final int? nextBeforeSeq;
  final bool isDone;

  const HistoryPage({
    required this.items,
    required this.nextBeforeSeq,
    required this.isDone,
  });
}

/// A row from `sessions:list`/`sessions:watch`. `title` + `runtime` decrypted.
class SessionRow {
  final String sessionId;
  final String? title;
  final String? cwd; // decrypted working directory, used to group by workspace
  final SessionStatus status;
  final AgentState agentState;
  final String executionMode;
  final int headSeq;
  final int updatedAt;

  /// When the last user prompt entered this session (relay `lastPromptAt`).
  /// Unlike [updatedAt] — which the relay bumps on every streamed event — this
  /// only moves when a prompt is sent, so it's a stable sort key that doesn't
  /// make concurrently-running sessions swap positions on every delta. Null for
  /// sessions with no prompt yet (or pre-dating the field); callers fall back to
  /// [updatedAt] via [orderKey].
  final int? lastPromptAt;
  final RuntimeBadge? runtime;
  final bool starred;

  /// Whether THIS phone receives push notifications for this session. The relay
  /// resolves it per phone: the explicit subscription override if set, else the
  /// default (subscribed to sessions this phone started). Toggled from the
  /// session's overflow menu.
  final bool subscribed;

  const SessionRow({
    required this.sessionId,
    required this.title,
    this.cwd,
    required this.status,
    required this.agentState,
    required this.executionMode,
    required this.headSeq,
    required this.updatedAt,
    this.lastPromptAt,
    required this.runtime,
    this.starred = false,
    this.subscribed = false,
  });

  SessionRow copyWith({String? title, RuntimeBadge? runtime, int? headSeq}) =>
      SessionRow(
        sessionId: sessionId,
        title: title ?? this.title,
        cwd: cwd,
        status: status,
        agentState: agentState,
        executionMode: executionMode,
        headSeq: headSeq ?? this.headSeq,
        updatedAt: updatedAt,
        lastPromptAt: lastPromptAt,
        runtime: runtime ?? this.runtime,
        starred: starred,
        subscribed: subscribed,
      );

  /// Overlay the live per-session runtime snapshot (from `sessions:runtime`)
  /// onto this list-sourced row. The list no longer carries the runtime badge,
  /// so the session view merges it in here to drive the runtime header, approval
  /// bar, and "Messages" count without re-subscribing the whole list to churn.
  SessionRow withRuntime(SessionRuntimeSnapshot? snapshot) => snapshot == null
      ? this
      : copyWith(runtime: snapshot.badge, headSeq: snapshot.headSeq);

  /// Stable ordering key for the session list: last prompt time when known,
  /// else the last activity time. See [lastPromptAt].
  int get orderKey => lastPromptAt ?? updatedAt;

  bool get isLive =>
      status == SessionStatus.running || status == SessionStatus.idle;

  /// Human label for the workspace this session runs in. Prefers the decrypted
  /// [cwd]; falls back to the workspace suffix embedded in the title
  /// (`Runtime · workspace`), then to a generic bucket.
  String get workspaceName {
    final dir = cwd?.trim() ?? '';
    if (dir.isNotEmpty) {
      return workspaceDisplayName(dir);
    }
    final t = title ?? '';
    final idx = t.lastIndexOf(' · ');
    if (idx >= 0) {
      final suffix = t.substring(idx + 3).trim();
      if (suffix.isNotEmpty) return suffix;
    }
    return 'Other';
  }
}

/// Token accounting for a session, mirrored from the desktop's TokenUsageStats.
/// Arrives inside the decrypted runtime payload — the relay never sees it.
class TokenUsage {
  final int inputTokens;
  final int outputTokens;
  final int cacheCreationInputTokens;
  final int cacheReadInputTokens;
  final int totalTokens;

  const TokenUsage({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheCreationInputTokens = 0,
    this.cacheReadInputTokens = 0,
    this.totalTokens = 0,
  });

  bool get isEmpty => total == 0;

  /// Prefer the desktop-reported total; fall back to summing the parts.
  int get total => totalTokens > 0
      ? totalTokens
      : inputTokens +
          outputTokens +
          cacheCreationInputTokens +
          cacheReadInputTokens;

  static TokenUsage? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final m = Map<String, dynamic>.from(raw);
    int n(String k) => (m[k] as num?)?.toInt() ?? 0;
    final usage = TokenUsage(
      inputTokens: n('inputTokens'),
      outputTokens: n('outputTokens'),
      cacheCreationInputTokens: n('cacheCreationInputTokens'),
      cacheReadInputTokens: n('cacheReadInputTokens'),
      totalTokens: n('totalTokens'),
    );
    return usage;
  }
}

/// Dollar split of a token total, as the desktop's usage ledger priced it.
/// [priced] is false when the desktop holds no rate for a model that was used,
/// so the amounts under-report rather than guessing.
class UsageCostBreakdown {
  final double inputUsd;
  final double outputUsd;
  final double cacheWriteUsd;
  final double cacheReadUsd;
  final double totalUsd;
  final bool priced;

  const UsageCostBreakdown({
    this.inputUsd = 0,
    this.outputUsd = 0,
    this.cacheWriteUsd = 0,
    this.cacheReadUsd = 0,
    this.totalUsd = 0,
    this.priced = true,
  });

  static UsageCostBreakdown fromDecrypted(Object? raw) {
    if (raw is! Map) return const UsageCostBreakdown();
    final m = Map<String, dynamic>.from(raw);
    double d(String k) => (m[k] as num?)?.toDouble() ?? 0;
    return UsageCostBreakdown(
      inputUsd: d('inputUsd'),
      outputUsd: d('outputUsd'),
      cacheWriteUsd: d('cacheWriteUsd'),
      cacheReadUsd: d('cacheReadUsd'),
      totalUsd: d('totalUsd'),
      priced: m['priced'] != false,
    );
  }
}

/// One (provider, model) slice of a usage report.
class UsageCostGroup {
  final AgentRuntime runtime;
  final String model;
  final String modelLabel;

  /// "$5.00 in · $25.00 out per Mtok" — null when the model has no known rate.
  final String? rateSummary;
  final TokenUsage tokens;
  final UsageCostBreakdown cost;

  const UsageCostGroup({
    required this.runtime,
    required this.model,
    required this.modelLabel,
    required this.rateSummary,
    required this.tokens,
    required this.cost,
  });

  static UsageCostGroup fromDecrypted(Map<String, dynamic> m) {
    return UsageCostGroup(
      runtime: agentRuntimeFrom(m['runtime'] as String?),
      model: (m['model'] as String?) ?? '',
      modelLabel: (m['modelLabel'] as String?) ?? 'Unspecified model',
      rateSummary: m['rateSummary'] as String?,
      tokens: TokenUsage.tryParse(m['tokens']) ?? const TokenUsage(),
      cost: UsageCostBreakdown.fromDecrypted(m['cost']),
    );
  }
}

/// A token→dollar report computed by the desktop's usage ledger. Scoped either to
/// one session or to a date range. The ledger only exists on the desktop, so this
/// always arrives as the answer to a `usage-cost` command round-trip.
class UsageCostReport {
  final TokenUsage tokens;
  final UsageCostBreakdown cost;
  final List<UsageCostGroup> groups;

  /// Models the desktop saw tokens for but holds no rate for.
  final List<String> unpricedModels;
  final int sessionCount;

  const UsageCostReport({
    this.tokens = const TokenUsage(),
    this.cost = const UsageCostBreakdown(),
    this.groups = const [],
    this.unpricedModels = const [],
    this.sessionCount = 0,
  });

  bool get isEmpty => tokens.total == 0;

  static UsageCostReport fromDecrypted(Map<String, dynamic> m) {
    return UsageCostReport(
      tokens: TokenUsage.tryParse(m['tokens']) ?? const TokenUsage(),
      cost: UsageCostBreakdown.fromDecrypted(m['cost']),
      groups: ((m['groups'] as List?) ?? const [])
          .whereType<Map>()
          .map((raw) =>
              UsageCostGroup.fromDecrypted(Map<String, dynamic>.from(raw)))
          .toList(),
      unpricedModels: ((m['unpricedModels'] as List?) ?? const [])
          .whereType<String>()
          .toList(),
      sessionCount: (m['sessionCount'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Money for a usage readout. Sub-cent amounts still have to read as a real
/// number, so precision grows as the amount shrinks — mirrors `formatUsd` in the
/// desktop's shared/pricing.ts.
String formatUsd(double value) {
  if (value.isNaN || value <= 0) return '\$0.00';
  if (value < 0.01) return '\$${value.toStringAsFixed(4)}';
  if (value < 1) return '\$${value.toStringAsFixed(3)}';
  if (value < 1000) return '\$${value.toStringAsFixed(2)}';
  return '\$${value.round()}';
}

/// Live snapshot for a single open session from `sessions:runtime`: the head
/// cursor ([headSeq], also the transcript "Messages" count) plus the decrypted
/// runtime [badge]. Split out of the list rows so the per-token runtime firehose
/// only reaches the session currently on screen.
class SessionRuntimeSnapshot {
  final int headSeq;
  final RuntimeBadge? badge;

  const SessionRuntimeSnapshot({required this.headSeq, this.badge});
}

class ApprovalOption {
  final String id;
  final String label;
  final String? hint;
  final String? tone;

  const ApprovalOption({
    required this.id,
    required this.label,
    this.hint,
    this.tone,
  });

  factory ApprovalOption.fromDecrypted(Map<String, dynamic> json) =>
      ApprovalOption(
        id: (json['id'] as String?) ?? '',
        label: (json['label'] as String?) ?? '',
        hint: json['hint'] as String?,
        tone: json['tone'] as String?,
      );

  bool get isDeny => tone == 'deny' || id == 'decline';
}

class PendingApproval {
  final String promptId;
  final String kind;
  final String title;
  final String body;
  final String? reason;
  final String? cwd;
  final List<ApprovalOption> options;
  final bool allowsFreeText;
  final int? questionCount;
  final int? questionIndex;

  const PendingApproval({
    required this.promptId,
    required this.kind,
    required this.title,
    required this.body,
    this.reason,
    this.cwd,
    this.options = const [],
    this.allowsFreeText = false,
    this.questionCount,
    this.questionIndex,
  });

  factory PendingApproval.fromDecrypted(Map<String, dynamic> json) =>
      PendingApproval(
        promptId: (json['promptId'] as String?) ?? '',
        kind: (json['kind'] as String?) ?? '',
        title: (json['title'] as String?) ?? '',
        body: (json['body'] as String?) ?? '',
        reason: json['reason'] as String?,
        cwd: json['cwd'] as String?,
        options: ((json['options'] as List?) ?? const [])
            .whereType<Map>()
            .map((raw) =>
                ApprovalOption.fromDecrypted(Map<String, dynamic>.from(raw)))
            .where((option) => option.id.isNotEmpty && option.label.isNotEmpty)
            .toList(),
        allowsFreeText: json['allowsFreeText'] == true,
        questionCount: (json['questionCount'] as num?)?.toInt(),
        questionIndex: (json['questionIndex'] as num?)?.toInt(),
      );
}

/// Low-frequency runtime badge (from `SessionRuntimeEvent`, decrypted).
class RuntimeBadge {
  final AgentState agentState;
  final String? latestTool;
  final String? latestCommand;
  final String? currentEventType;
  final String? pendingPromptId; // set when a tool-permission prompt is waiting
  final PendingApproval? pendingApproval;
  final TokenUsage? tokenUsage;
  final String? claudeSessionId;
  final String? model; // current model, when the desktop reports it
  final String? lastMessage; // short snippet of the latest assistant text
  final AgentRuntime?
      runtime; // which runtime backs this session (claude/codex)

  const RuntimeBadge({
    required this.agentState,
    this.latestTool,
    this.latestCommand,
    this.currentEventType,
    this.pendingPromptId,
    this.pendingApproval,
    this.tokenUsage,
    this.claudeSessionId,
    this.model,
    this.lastMessage,
    this.runtime,
  });

  factory RuntimeBadge.fromDecrypted(Map<String, dynamic> json) => RuntimeBadge(
        agentState: agentStateFrom((json['agentState'] as String?) ?? 'exited'),
        latestTool: json['latestTool'] as String?,
        latestCommand: json['latestCommand'] as String?,
        currentEventType: json['currentEventType'] as String?,
        pendingPromptId: json['pendingPromptId'] as String?,
        pendingApproval: _pendingApprovalFrom(json['pendingApproval']),
        tokenUsage: TokenUsage.tryParse(json['tokenUsage']),
        claudeSessionId: json['claudeSessionId'] as String?,
        model: json['latestModel'] as String? ?? json['model'] as String?,
        lastMessage: json['latestAssistantText'] as String?,
        runtime: _runtimeFrom(json),
      );

  static PendingApproval? _pendingApprovalFrom(Object? raw) {
    if (raw is! Map) return null;
    final approval =
        PendingApproval.fromDecrypted(Map<String, dynamic>.from(raw));
    return approval.promptId.isEmpty ? null : approval;
  }

  /// Resolve the session's runtime from the badge. Prefers the explicit
  /// `runtime` field (newer desktop); otherwise infers codex from a codex thread
  /// id, else defaults to claude.
  static AgentRuntime? _runtimeFrom(Map<String, dynamic> json) {
    switch (json['runtime'] as String?) {
      case 'codex':
        return AgentRuntime.codex;
      case 'claude':
        return AgentRuntime.claude;
    }
    if ((json['codexThreadId'] as String?)?.isNotEmpty == true) {
      return AgentRuntime.codex;
    }
    return null;
  }
}

/// Delivery state of a locally-composed user message. Server-sourced items are
/// always [none]; an optimistic echo starts [sending] and flips to [failed] if
/// the relay send throws (surfacing a tap-to-retry affordance).
enum SendState { none, sending, failed }

/// One conversation delta from `sessions:tail`. Content already decrypted.
class ConversationItem {
  final String id;
  final String kind; // user | assistant | tool | system | marker
  final String? title;
  final String body;
  final int? sequence;
  final String? model;
  final bool thinking; // assistant "thinking" block
  final ToolData? tool; // present for tool calls
  final List<ConversationImage> images;
  final int? createdAt; // event envelope timestamp (ms), not encrypted
  final int?
      timestamp; // desktop-stamped logical time (ms) — the true order key
  final bool queued; // local-only: sent while the agent was busy
  final SendState sendState; // local-only: optimistic-send delivery state

  const ConversationItem({
    required this.id,
    required this.kind,
    required this.title,
    required this.body,
    required this.sequence,
    required this.model,
    required this.thinking,
    required this.tool,
    this.images = const [],
    this.createdAt,
    this.timestamp,
    this.queued = false,
    this.sendState = SendState.none,
  });

  /// Logical position in the feed. The relay assigns `seq` at flush time (which
  /// can reorder a user message behind the assistant deltas it preceded), so we
  /// sort by the desktop's logical [timestamp], falling back to the envelope
  /// [createdAt] and finally [sequence].
  int get orderMs => timestamp ?? createdAt ?? 0;

  ConversationItem copyWith({
    ToolData? tool,
    SendState? sendState,
    List<ConversationImage>? images,
    String? body,
  }) =>
      ConversationItem(
        id: id,
        kind: kind,
        title: title,
        body: body ?? this.body,
        sequence: sequence,
        model: model,
        thinking: thinking,
        tool: tool ?? this.tool,
        images: images ?? this.images,
        createdAt: createdAt,
        timestamp: timestamp,
        queued: queued,
        sendState: sendState ?? this.sendState,
      );

  factory ConversationItem.fromDecrypted(
    Map<String, dynamic> json,
    int seq, {
    int? createdAt,
  }) {
    final kind = (json['kind'] as String?) ?? 'system';
    final title = json['title'] as String?;
    final body = (json['body'] as String?) ?? '';
    // The desktop streams reasoning as a system item titled "Thinking" rather
    // than setting a `thinking` flag; treat both shapes as a thinking block.
    final thinking =
        json['thinking'] == true || (kind == 'system' && title == 'Thinking');
    // Prefer a structured `tool` object (newer desktop); otherwise reconstruct
    // one from the title + body the desktop streams today.
    ToolData? tool = ToolData.tryParse(json);
    if (tool == null && kind == 'tool') {
      tool = ToolData.synthesize(
        title: title ?? 'Tool',
        body: body,
        isResult: title == 'Tool result' ||
            (json['id'] as String?)?.endsWith(':result') == true,
      );
    }
    return ConversationItem(
      id: (json['id'] as String?) ?? 'seq-$seq',
      kind: kind,
      title: title,
      body: body,
      sequence: seq,
      model: json['model'] as String?,
      thinking: thinking,
      tool: tool,
      createdAt: createdAt,
      timestamp: DateTime.tryParse(json['timestamp'] as String? ?? '')
          ?.millisecondsSinceEpoch,
    );
  }
}

/// One plan-usage rate-limit window (e.g. "5-hour", "Weekly"), mirrored from the
/// desktop's `UsageWindow`. Utilization is a 0–100 percentage.
class UsageWindow {
  final String key;
  final String label;
  final double utilization;
  final DateTime? resetsAt;

  const UsageWindow({
    required this.key,
    required this.label,
    required this.utilization,
    this.resetsAt,
  });

  static UsageWindow? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final m = Map<String, dynamic>.from(raw);
    final key = m['key'] as String?;
    final label = m['label'] as String?;
    final util = (m['utilization'] as num?)?.toDouble();
    if (key == null || label == null || util == null) return null;
    return UsageWindow(
      key: key,
      label: label,
      utilization: util.clamp(0, 100).toDouble(),
      resetsAt: DateTime.tryParse(m['resetsAt'] as String? ?? ''),
    );
  }
}

/// Account plan-usage snapshot (rate-limit windows), decrypted from the device
/// row. Only the desktop can fetch this — it holds the OAuth creds — so the
/// phone renders whatever the desktop last pushed on its heartbeat.
class UsageSnapshot {
  final String provider;
  final List<UsageWindow> windows;
  final DateTime? fetchedAt;

  const UsageSnapshot({
    required this.provider,
    required this.windows,
    this.fetchedAt,
  });

  static UsageSnapshot? fromDecrypted(Map<String, dynamic> json) {
    final rawWindows = (json['windows'] as List?) ?? const [];
    final windows =
        rawWindows.map(UsageWindow.tryParse).whereType<UsageWindow>().toList();
    if (windows.isEmpty) return null;
    return UsageSnapshot(
      provider: (json['provider'] as String?) ?? 'claude',
      windows: windows,
      fetchedAt: DateTime.tryParse(json['fetchedAt'] as String? ?? ''),
    );
  }
}
