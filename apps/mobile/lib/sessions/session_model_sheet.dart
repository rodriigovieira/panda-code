import 'package:flutter/material.dart';

import '../security/biometric_auth.dart';
import '../theme/panda_tokens.dart';
import '../widgets/toast/panda_toast.dart';
import 'models.dart';
import 'widgets/selector_controls.dart';

/// What a user chose for an already-running session. A `null` field means
/// "leave it untouched"; an empty string means "reset to the runtime default".
/// Only changed fields ride the switch command so a model-only swap never
/// disturbs the session's effort or sandbox. A non-null [runtime] switches
/// provider (Claude ↔ Codex) — a fresh thread, since context can't cross
/// providers.
class LaunchOverride {
  final AgentRuntime? runtime;
  final String? model;
  final String? effort;
  final String? permissionMode;

  const LaunchOverride({
    this.runtime,
    this.model,
    this.effort,
    this.permissionMode,
  });

  bool get hasChanges =>
      runtime != null ||
      model != null ||
      effort != null ||
      permissionMode != null;
}

/// Bottom sheet for switching a live session's model/reasoning/permissions.
///
/// Uses the desktop ModelSelector's grammar: ordinal choices (model tier,
/// effort) get a tick slider, discrete ones (provider, permissions) get pills.
/// Learn it once and it reads the same on both platforms.
Future<LaunchOverride?> showModelSwitchSheet(
  BuildContext context, {
  required AgentRuntime runtime,
  String? currentModel,
  String? currentEffort,
  String? currentPermission,
}) {
  return showModalBottomSheet<LaunchOverride>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _ModelSwitchSheet(
      runtime: runtime,
      currentModel: currentModel,
      currentEffort: currentEffort,
      currentPermission: currentPermission,
    ),
  );
}

class _ModelSwitchSheet extends StatefulWidget {
  const _ModelSwitchSheet({
    required this.runtime,
    this.currentModel,
    this.currentEffort,
    this.currentPermission,
  });

  final AgentRuntime runtime;
  final String? currentModel;
  final String? currentEffort;
  final String? currentPermission;

  @override
  State<_ModelSwitchSheet> createState() => _ModelSwitchSheetState();
}

class _ModelSwitchSheetState extends State<_ModelSwitchSheet> {
  // The provider the sheet is currently configuring. Starts on the session's
  // runtime; changing it switches provider (a fresh thread).
  late AgentRuntime _runtime = widget.runtime;
  // null → untouched (send nothing). A non-null value → the user picked it.
  String? _model;
  String? _effort;
  String? _permission;

  /// Whether the secondary model variants are expanded.
  bool _showVariants = false;

  @override
  void initState() {
    super.initState();
    // Seed the model from what the desktop last reported, so the sheet opens on
    // the current model when it maps to a known option (else it stays "pick a
    // model"). Effort/permission aren't reported back, so they start untouched.
    _model = _knownModelValue(widget.currentModel);
    _showVariants = _model != null && !_ramp.contains(_model);
  }

  bool get _isCodex => _runtime == AgentRuntime.codex;
  bool get _runtimeChanged => _runtime != widget.runtime;

  List<LaunchOption> get _rampOptions => modelRampFor(_runtime);
  List<String> get _ramp => _rampOptions.map((o) => o.value).toList();
  List<LaunchOption> get _variantOptions => modelVariantsFor(_runtime);
  bool get _modelUsesSlider => modelUsesSlider(_runtime);

  void _setRuntime(AgentRuntime runtime) {
    if (_runtime == runtime) return;
    setState(() {
      _runtime = runtime;
      // The option lists differ per provider — reset the picks so we never send
      // a Claude model to Codex (or vice versa).
      _model = null;
      _effort = null;
      _permission = null;
      _showVariants = false;
    });
  }

  /// The option value that matches [reported], or null when the reported model
  /// isn't one of the presets (e.g. a pinned full model id). Keeps the picker
  /// from showing a stale highlight.
  String? _knownModelValue(String? reported) {
    final trimmed = reported?.trim() ?? '';
    if (trimmed.isEmpty) return null;
    for (final option in modelOptionsFor(_runtime)) {
      if (option.value == trimmed) return trimmed;
    }
    return null;
  }

  /// Where a slider should sit for an untouched row: on the session's current
  /// value when we know it, otherwise at the first stop (the runtime default).
  int _indexFor(List<LaunchOption> options, String? picked, String? current) {
    final value = picked ?? current?.trim();
    if (value == null || value.isEmpty) return 0;
    final i = options.indexWhere((o) => o.value == value);
    return i < 0 ? 0 : i;
  }

  Future<void> _apply() async {
    final override = LaunchOverride(
      runtime: _runtimeChanged ? _runtime : null,
      model: _model,
      effort: _effort,
      permissionMode: _permission,
    );
    if (!override.hasChanges) {
      Navigator.of(context).pop();
      return;
    }
    // Loosening the sandbox / bypassing permissions grants unrestricted access,
    // exactly like starting a full-access session — gate it behind Face ID.
    if (isFullAccessPermissionMode(_permission)) {
      final ok = await BiometricAuth.authenticate();
      if (!ok) {
        showToast('Face ID required to grant full access',
            variant: ToastVariant.error);
        return;
      }
    }
    if (mounted) Navigator.of(context).pop(override);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final theme = Theme.of(context);
    final changed = _runtimeChanged ||
        _model != null ||
        _effort != null ||
        _permission != null;

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(_isCodex ? Icons.terminal : Icons.auto_awesome,
                    size: 20, color: t.accent.text),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Runtime',
                    style: theme.textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // Codex can only take model/effort overrides on turn/start — there is
            // no thread-level parameter — so nothing here takes effect mid-turn.
            SelectorHint(
              _runtimeChanged
                  ? 'Switching provider starts a fresh ${agentRuntimeLabel(_runtime)} thread — '
                      'the current conversation isn’t carried over.'
                  : 'Applies from your next message — the current context is kept.',
              tone: _runtimeChanged ? t.warn.text : null,
            ),
            const SizedBox(height: 16),

            // Provider — discrete, so pills (rendered as a segmented control,
            // since there are exactly two and they are mutually exclusive).
            SizedBox(
              width: double.infinity,
              child: SegmentedButton<AgentRuntime>(
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
                selected: {_runtime},
                showSelectedIcon: false,
                onSelectionChanged: (s) => _setRuntime(s.first),
              ),
            ),
            const SizedBox(height: 20),

            _buildModelRow(t),
            const SizedBox(height: 20),
            _buildEffortRow(t),
            const SizedBox(height: 20),
            _buildPermissionRow(t),

            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: changed ? _apply : null,
              icon: const Icon(Icons.check),
              label: Text(_runtimeChanged
                  ? 'Switch to ${agentRuntimeLabel(_runtime)}'
                  : 'Apply changes'),
            ),
          ],
        ),
      ),
    );
  }

  // ---- Model -------------------------------------------------------------
  // Accent-coloured, because the model is the headline choice.

  Widget _buildModelRow(PandaTokens t) {
    final accent = t.accent.text;
    final all = modelOptionsFor(_runtime);
    final untouched = _model == null;

    if (!_modelUsesSlider) {
      final selected = _optionFor(all, _model);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SelectorHeader(
            label: 'Model',
            icon: Icons.memory_outlined,
            accent: accent,
            value: selected?.label ?? _modelPlaceholder(),
            badge: selected?.badge,
            muted: untouched,
          ),
          const SizedBox(height: 10),
          SelectorPills(
            options: all,
            value: _model,
            accent: accent,
            onChanged: (v) => setState(() => _model = v),
          ),
          if (selected != null) ...[
            const SizedBox(height: 8),
            SelectorHint(selected.hint),
          ],
        ],
      );
    }

    final ramp = _rampOptions;
    final variants = _variantOptions;
    // A variant is selected -> the slider has no meaningful position, so show
    // the variant as the value and leave the ramp where the default sits.
    final onVariant = _model != null && !_ramp.contains(_model);
    final index = onVariant ? 0 : _indexFor(ramp, _model, widget.currentModel);
    final shown = onVariant ? _optionFor(all, _model) : ramp[index];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectorHeader(
          label: 'Model',
          icon: Icons.memory_outlined,
          accent: accent,
          value: shown?.label ?? _modelPlaceholder(),
          badge: shown?.badge,
          muted: untouched,
        ),
        const SizedBox(height: 6),
        Opacity(
          // Dim the ramp while a variant is active — it is not what is in effect.
          opacity: onVariant ? 0.45 : 1,
          child: SelectorSlider(
            options: ramp,
            index: index,
            accent: accent,
            semanticLabel: 'Model',
            onChanged: (i) => setState(() {
              _model = ramp[i].value;
              _showVariants = false;
            }),
          ),
        ),
        const SizedBox(height: 6),
        SelectorHint(shown?.hint ?? ramp.map((o) => o.label).join(' · ')),
        if (variants.isNotEmpty) ...[
          const SizedBox(height: 10),
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
          if (_showVariants) ...[
            const SizedBox(height: 4),
            SelectorPills(
              options: variants,
              value: onVariant ? _model : null,
              accent: accent,
              onChanged: (v) => setState(() => _model = v),
            ),
          ],
        ],
      ],
    );
  }

  // ---- Effort ------------------------------------------------------------
  // Green, mirroring the desktop row's own `--slider-accent` override. A second
  // hue here is not decoration: it stops two adjacent sliders reading as one
  // control with a gap in it.

  Widget _buildEffortRow(PandaTokens t) {
    final options = effortOptionsFor(_runtime);
    final index = _indexFor(options, _effort, widget.currentEffort);
    final selected = options[index];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectorHeader(
          label: _isCodex ? 'Reasoning' : 'Effort',
          icon: Icons.bolt_outlined,
          accent: t.run.text,
          value: selected.label,
          muted: _effort == null,
        ),
        const SizedBox(height: 6),
        SelectorSlider(
          options: options,
          index: index,
          accent: t.run.text,
          semanticLabel: _isCodex ? 'Reasoning' : 'Effort',
          onChanged: (i) => setState(() => _effort = options[i].value),
        ),
        const SizedBox(height: 6),
        SelectorHint(selected.hint),
      ],
    );
  }

  // ---- Permissions -------------------------------------------------------
  // Discrete and emphatically NOT ordinal, so pills. "Full access" takes the
  // danger colour so it can never be mistaken for one more notch along a ramp.

  Widget _buildPermissionRow(PandaTokens t) {
    final options = permissionOptionsFor(_runtime);
    final selected = _optionFor(options, _permission);
    final isFullAccess = isFullAccessPermissionMode(_permission);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectorHeader(
          label: _isCodex ? 'Sandbox' : 'Permissions',
          icon: Icons.shield_outlined,
          accent: isFullAccess ? t.danger.text : t.accent.text,
          value: selected?.label ?? _permissionPlaceholder(),
          muted: _permission == null,
        ),
        const SizedBox(height: 10),
        SelectorPills(
          options: options,
          value: _permission,
          accent: t.accent.text,
          dangerValues: fullAccessPermissionModes,
          onChanged: (v) => setState(() => _permission = v),
        ),
        if (selected != null) ...[
          const SizedBox(height: 8),
          SelectorHint(selected.hint,
              tone: isFullAccess ? t.danger.text : null),
        ],
      ],
    );
  }

  LaunchOption? _optionFor(List<LaunchOption> options, String? value) {
    if (value == null) return null;
    for (final option in options) {
      if (option.value == value) return option;
    }
    return LaunchOption(value: value, label: value, hint: '');
  }

  String _modelPlaceholder() {
    final current = widget.currentModel?.trim() ?? '';
    return current.isEmpty ? 'Choose a model' : current;
  }

  String _permissionPlaceholder() =>
      _runtimeChanged ? (_isCodex ? 'Read-only' : 'Ask') : 'Keep current';
}
