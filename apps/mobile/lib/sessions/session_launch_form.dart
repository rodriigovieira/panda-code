import 'package:flutter/material.dart';

import '../theme/panda_tokens.dart';
import 'models.dart';
import 'widgets/selector_controls.dart';

/// A workspace the user can launch a session in. Sourced from the folders that
/// already exist on the desktop app (derived from known sessions), never typed
/// by hand — the phone must not be able to reach arbitrary filesystem paths.
class WorkspaceOption {
  final String path;
  const WorkspaceOption(this.path);

  /// Folder name (last path component) shown as the primary label.
  String get name => workspaceDisplayName(path);
}

/// Distinct workspaces across the known sessions, most recently active first.
/// This is the same set the desktop groups its threads into, so the phone can
/// only pick a folder that already exists on the Mac.
List<WorkspaceOption> workspaceOptionsFromSessions(Iterable<SessionRow> rows) {
  final latestByPath = <String, int>{};
  for (final row in rows) {
    final dir = row.cwd?.trim() ?? '';
    if (dir.isEmpty) continue;
    final prev = latestByPath[dir];
    if (prev == null || row.updatedAt > prev) latestByPath[dir] = row.updatedAt;
  }
  final entries = latestByPath.entries.toList()
    ..sort((a, b) => b.value.compareTo(a.value));
  return [for (final e in entries) WorkspaceOption(e.key)];
}

/// Optional pre-fill for the create sheet, sourced from user settings.
class SessionDefaults {
  final AgentRuntime runtime;
  final String model;
  final String permissionMode;

  const SessionDefaults({
    this.runtime = AgentRuntime.claude,
    this.model = '',
    this.permissionMode = '',
  });
}

/// The launch selectors — workspace, runtime, model, effort, permissions — as a
/// controlled widget. Deliberately owns no state: the draft sheet holds it, so
/// every selector stays in step with the composer.
/// Used to pop a config and fire a `start` immediately; that produced sessions
/// nobody had typed into yet, so the create sheet now hosts a composer and waits
/// for the first prompt (see NewSessionScreen).
class SessionLaunchForm extends StatelessWidget {
  const SessionLaunchForm({
    super.key,
    required this.workspaces,
    required this.workspace,
    required this.runtime,
    required this.model,
    required this.effort,
    required this.permissionMode,
    required this.customModelController,
    required this.onPickWorkspace,
    required this.onRuntimeChanged,
    required this.onModelChanged,
    required this.onEffortChanged,
    required this.onPermissionChanged,
  });

  final List<WorkspaceOption> workspaces;
  final WorkspaceOption? workspace;
  final AgentRuntime runtime;
  final String model;
  final String effort;
  final String permissionMode;
  final TextEditingController customModelController;
  final VoidCallback onPickWorkspace;
  final ValueChanged<AgentRuntime> onRuntimeChanged;
  final ValueChanged<String> onModelChanged;
  final ValueChanged<String> onEffortChanged;
  final ValueChanged<String> onPermissionChanged;

  @override
  Widget build(BuildContext context) {
    final modelHint = _hintFor(modelOptionsFor(runtime), model);
    final effortHint = _hintFor(effortOptionsFor(runtime), effort);
    final permissionHint =
        _hintFor(permissionOptionsFor(runtime), permissionMode);
    final effortOptions = effortOptionsFor(runtime);
    var effortIndex = effortOptions.indexWhere((o) => o.value == effort);
    if (effortIndex < 0) effortIndex = 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SegmentedButton<AgentRuntime>(
          segments: const [
            ButtonSegment(
                value: AgentRuntime.claude,
                label: Text('Claude'),
                icon: Icon(Icons.auto_awesome)),
            ButtonSegment(
                value: AgentRuntime.codex,
                label: Text('Codex'),
                icon: Icon(Icons.terminal)),
          ],
          selected: {runtime},
          onSelectionChanged: (selection) => onRuntimeChanged(selection.first),
        ),
        const SizedBox(height: 16),
        WorkspaceField(
          workspace: workspace,
          onTap: workspaces.isEmpty ? null : onPickWorkspace,
        ),
        if (workspaces.isEmpty)
          const FieldHint('No workspaces yet. Open a project folder in the '
              'desktop app first — you can only start sessions in '
              'folders already added there.'),
        const SizedBox(height: 12),
        ModelSelector(
          runtime: runtime,
          value: model,
          onChanged: (value) {
            customModelController.clear();
            onModelChanged(value);
          },
        ),
        if (modelHint.isNotEmpty) FieldHint(modelHint),
        const SizedBox(height: 10),
        TextFormField(
          controller: customModelController,
          decoration: InputDecoration(
            labelText: 'Custom model',
            hintText: runtime == AgentRuntime.codex
                ? 'gpt-...'
                : 'claude-... or alias',
            prefixIcon: const Icon(Icons.edit_outlined),
            border: const OutlineInputBorder(),
          ),
          textInputAction: TextInputAction.next,
          onChanged: (value) {
            if (value.trim().isNotEmpty && model.isNotEmpty) onModelChanged('');
          },
        ),
        const SizedBox(height: 12),
        // Effort is a genuine ordinal ramp, so it gets the slider —
        // same control, same green accent as the switch sheet.
        SelectorHeader(
          label: runtime == AgentRuntime.codex ? 'Reasoning' : 'Effort',
          icon: Icons.bolt_outlined,
          accent: context.tokens.run.text,
          value: effortOptions[effortIndex].label,
        ),
        const SizedBox(height: 6),
        SelectorSlider(
          options: effortOptions,
          index: effortIndex,
          accent: context.tokens.run.text,
          semanticLabel: runtime == AgentRuntime.codex ? 'Reasoning' : 'Effort',
          onChanged: (i) => onEffortChanged(effortOptions[i].value),
        ),
        if (effortHint.isNotEmpty) FieldHint(effortHint),
        const SizedBox(height: 16),
        // Permissions are discrete and emphatically not ordinal, so
        // pills — and full access takes the danger colour, never the
        // accent, so it cannot read as one more notch along a ramp.
        SelectorHeader(
          label: runtime == AgentRuntime.codex ? 'Sandbox' : 'Permissions',
          icon: Icons.shield_outlined,
          accent: isFullAccessPermissionMode(permissionMode)
              ? context.tokens.danger.text
              : context.tokens.accent.text,
          value: launchOptionLabel(
              permissionOptionsFor(runtime), permissionMode, 'Ask'),
        ),
        const SizedBox(height: 10),
        SelectorPills(
          options: permissionOptionsFor(runtime),
          value: permissionMode,
          dangerValues: fullAccessPermissionModes,
          onChanged: onPermissionChanged,
        ),
        if (permissionHint.isNotEmpty) FieldHint(permissionHint),
      ],
    );
  }

  String _hintFor(List<LaunchOption> options, String value) {
    return options
        .firstWhere(
          (option) => option.value == value,
          orElse: () => const LaunchOption(value: '', label: '', hint: ''),
        )
        .hint;
  }
}

/// The launch settings a fresh draft starts from, sourced from user settings and
/// falling back to the runtime's own default permission mode.
SessionDraft draftFromDefaults(
    SessionDefaults defaults, String? workspacePath) {
  return SessionDraft(
    workspacePath: workspacePath,
    runtime: defaults.runtime,
    model: defaults.model,
    permissionMode: defaults.permissionMode.trim().isNotEmpty
        ? defaults.permissionMode.trim()
        : defaultPermissionModeForRuntime(defaults.runtime),
  );
}

/// Bottom-sheet picker for a single launch option (model, effort, sandbox…).
/// Shares the card-tile look of [showWorkspacePicker] so every selector in the
/// create sheet feels consistent, and surfaces each option's hint + badge.
Future<String?> showOptionPicker(
  BuildContext context, {
  required String title,
  required IconData icon,
  required List<LaunchOption> options,
  required String selected,
}) {
  final theme = Theme.of(context);
  final t = context.tokens;
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: false,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 12),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: t.lineHi,
              borderRadius: t.radius.pillR,
            ),
          ),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Row(
              children: [
                Icon(icon, size: 20, color: t.text),
                const SizedBox(width: 10),
                Text(title,
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700)),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
              itemCount: options.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final option = options[i];
                final isSelected = option.value == selected;
                return Material(
                  color: t.panel,
                  borderRadius: t.radius.lgR,
                  child: InkWell(
                    borderRadius: t.radius.lgR,
                    onTap: () => Navigator.of(context).pop(option.value),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        borderRadius: t.radius.lgR,
                        border: Border.all(
                          color: isSelected ? t.accent.edgeStrong : t.line,
                          width: t.control.borderWidth,
                        ),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Flexible(
                                      child: Text(option.label,
                                          style: TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600)),
                                    ),
                                    if (option.badge != null) ...[
                                      SizedBox(width: 8),
                                      _OptionBadge(option.badge!),
                                    ],
                                  ],
                                ),
                                if (option.hint.isNotEmpty) ...[
                                  const SizedBox(height: 3),
                                  Text(option.hint,
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                              color: context.tokens.subtle)),
                                ],
                              ],
                            ),
                          ),
                          SizedBox(width: 12),
                          if (isSelected)
                            Icon(Icons.check_circle, color: t.accent.text)
                          else
                            Icon(Icons.circle_outlined, color: t.subtle),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    ),
  );
}

class _OptionBadge extends StatelessWidget {
  const _OptionBadge(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = context.tokens;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: t.line, width: t.control.borderWidth),
        borderRadius: t.radius.pillR,
      ),
      child: Text(label,
          style: theme.textTheme.labelSmall?.copyWith(color: t.muted)),
    );
  }
}

/// Model picker shared in spirit with the switch sheet: the capability ramp on a
/// slider, the long-context / plan variants behind a "More models" expander.
class ModelSelector extends StatefulWidget {
  const ModelSelector({
    super.key,
    required this.runtime,
    required this.value,
    required this.onChanged,
  });

  final AgentRuntime runtime;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  State<ModelSelector> createState() => _ModelSelectorState();
}

class _ModelSelectorState extends State<ModelSelector> {
  bool _showVariants = false;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final accent = t.accent.text;
    final ramp = modelRampFor(widget.runtime);
    final variants = modelVariantsFor(widget.runtime);
    final all = modelOptionsFor(widget.runtime);
    final selected = all.where((o) => o.value == widget.value).firstOrNull;

    if (!modelUsesSlider(widget.runtime)) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SelectorHeader(
            label: 'Model',
            icon: Icons.memory_outlined,
            accent: accent,
            value: selected?.label,
            badge: selected?.badge,
          ),
          const SizedBox(height: 10),
          SelectorPills(
            options: all,
            value: widget.value,
            accent: accent,
            onChanged: widget.onChanged,
          ),
        ],
      );
    }

    final onVariant = !ramp.any((o) => o.value == widget.value);
    var index = ramp.indexWhere((o) => o.value == widget.value);
    if (index < 0) index = 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectorHeader(
          label: 'Model',
          icon: Icons.memory_outlined,
          accent: accent,
          value: selected?.label,
          badge: selected?.badge,
        ),
        const SizedBox(height: 6),
        Opacity(
          opacity: onVariant ? 0.45 : 1,
          child: SelectorSlider(
            options: ramp,
            index: index,
            accent: accent,
            semanticLabel: 'Model',
            onChanged: (i) {
              setState(() => _showVariants = false);
              widget.onChanged(ramp[i].value);
            },
          ),
        ),
        if (variants.isNotEmpty) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => setState(() => _showVariants = !_showVariants),
              icon: Icon(_showVariants ? Icons.expand_less : Icons.expand_more,
                  size: 18),
              label: Text(_showVariants ? 'Fewer options' : 'More models'),
              style: TextButton.styleFrom(
                foregroundColor: t.muted,
                minimumSize: Size(0, t.control.heightSm),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
            ),
          ),
          if (_showVariants)
            SelectorPills(
              options: variants,
              value: onVariant ? widget.value : null,
              accent: accent,
              onChanged: widget.onChanged,
            ),
        ],
      ],
    );
  }
}

class FieldHint extends StatelessWidget {
  const FieldHint(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
      child: Text(text,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: context.tokens.muted)),
    );
  }
}

/// Read-only field that shows the picked workspace and opens the picker on tap.
/// Replaces the old free-text path input so the phone can't reach arbitrary
/// filesystem locations.
class WorkspaceField extends StatelessWidget {
  const WorkspaceField(
      {super.key, required this.workspace, required this.onTap});

  final WorkspaceOption? workspace;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final w = workspace;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: 'Workspace',
          prefixIcon: Icon(Icons.folder_outlined),
          border: const OutlineInputBorder(),
          enabled: onTap != null,
        ),
        child: Row(
          children: [
            Expanded(
              child: w == null
                  ? Text('No workspace available',
                      style: TextStyle(color: theme.hintColor))
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(w.name,
                            style: TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(height: 2),
                        Text(w.path,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall
                                ?.copyWith(color: context.tokens.subtle)),
                      ],
                    ),
            ),
            if (onTap != null)
              Icon(Icons.expand_more, color: context.tokens.subtle),
          ],
        ),
      ),
    );
  }
}

/// Bottom-sheet picker listing the workspaces that exist on the desktop.
/// Card tiles rather than a plain list: a workspace is picked rarely and read
/// carefully, so the extra height buys legibility at no real cost.
Future<WorkspaceOption?> showWorkspacePicker(
  BuildContext context, {
  required List<WorkspaceOption> workspaces,
  WorkspaceOption? selected,
}) {
  final theme = Theme.of(context);
  final t = context.tokens;
  return showModalBottomSheet<WorkspaceOption>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: false,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 12),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: t.lineHi,
              borderRadius: t.radius.pillR,
            ),
          ),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Select workspace',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
              itemCount: workspaces.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final w = workspaces[i];
                final isSelected = w.path == selected?.path;
                return Material(
                  color: t.panel,
                  borderRadius: t.radius.lgR,
                  child: InkWell(
                    borderRadius: t.radius.lgR,
                    onTap: () => Navigator.of(context).pop(w),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        borderRadius: t.radius.lgR,
                        border: Border.all(
                          color: isSelected ? t.accent.edgeStrong : t.line,
                          width: t.control.borderWidth,
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.folder_outlined),
                          SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(w.name,
                                    style: const TextStyle(
                                        fontSize: 15,
                                        fontWeight: FontWeight.w600)),
                                const SizedBox(height: 2),
                                Text(w.path,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: theme.textTheme.bodySmall?.copyWith(
                                        color: context.tokens.subtle)),
                              ],
                            ),
                          ),
                          if (isSelected)
                            Icon(Icons.check_circle, color: t.accent.text)
                          else
                            Icon(Icons.chevron_right, color: t.subtle),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    ),
  );
}
