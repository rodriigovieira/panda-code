import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'models.dart';
import 'settings_store.dart';
import 'usage_cost_screen.dart';
import 'widgets/code_themes.dart';
import 'widgets/code_view.dart';

/// Device-local preferences: chat text size and the unpair (unsync) action,
/// moved here from the session list app bar.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings =
        ref.watch(settingsProvider).valueOrNull ?? const AppSettings();
    final notifier = ref.read(settingsProvider.notifier);
    final deviceName = ref.watch(deviceStatusProvider).valueOrNull?.name;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          const _SectionLabel('Appearance'),
          _AppearanceCard(settings: settings, notifier: notifier),
          const SizedBox(height: 24),
          const _SectionLabel('Chat'),
          _ChatTextSizeCard(
            scale: settings.chatTextScale,
            onChanged: (v) =>
                ref.read(settingsProvider.notifier).setChatTextScale(v),
          ),
          const SizedBox(height: 12),
          _ChatBehaviorCard(settings: settings, notifier: notifier),
          const SizedBox(height: 24),
          const _SectionLabel('New sessions'),
          _DefaultsCard(settings: settings, notifier: notifier),
          const SizedBox(height: 24),
          const _SectionLabel('Usage'),
          _UsageCostCard(),
          const SizedBox(height: 24),
          const _SectionLabel('Notifications'),
          _NotificationsCard(settings: settings, notifier: notifier),
          const SizedBox(height: 24),
          const _SectionLabel('Security'),
          _AppLockCard(
            enabled: settings.appLockEnabled,
            delay: settings.autoLockDelay,
            onToggle: (v) =>
                ref.read(settingsProvider.notifier).setAppLockEnabled(v),
            onDelayChanged: (v) =>
                ref.read(settingsProvider.notifier).setAutoLockDelay(v),
          ),
          const SizedBox(height: 24),
          const _SectionLabel('Device'),
          _UnpairCard(
            deviceName: deviceName,
            onUnpair: () => _confirmUnpair(context, ref),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmUnpair(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Unsync this Mac?'),
        content: const Text(
          'This phone will forget its pairing. You will need to scan the QR '
          'code again to reconnect. Running sessions are not affected.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: Theme.of(ctx).colorScheme.error),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Unsync'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    // Unpairing flips pairingProvider to null, so the app root swaps back to the
    // pairing screen; popping first avoids leaving this route on the stack.
    if (context.mounted) Navigator.of(context).pop();
    await ref.read(pairingProvider.notifier).unpair();
  }
}

/// Entry point to the global token→dollar report. The numbers come from the
/// paired desktop's usage ledger, so this is a link rather than an inline
/// readout — it needs a round-trip.
class _UsageCostCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        leading: const Icon(Icons.savings_outlined),
        title: const Text('Usage & cost'),
        subtitle: const Text('Token spend in dollars, by date range and model'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const UsageCostScreen()),
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Text(
        text.toUpperCase(),
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: context.tokens.subtle,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
            ),
      ),
    );
  }
}

class _ChatTextSizeCard extends StatelessWidget {
  const _ChatTextSizeCard({required this.scale, required this.onChanged});

  final double scale;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final percent = (scale * 100).round();
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.text_fields, size: 18),
                const SizedBox(width: 10),
                Text('Text size', style: theme.textTheme.titleMedium),
                const Spacer(),
                Text('$percent%',
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: context.tokens.muted)),
              ],
            ),
            SizedBox(height: 10),
            // Live preview at the selected scale.
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: context.tokens.panelHover,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                'The quick brown fox jumps over the lazy dog.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontSize:
                      (theme.textTheme.bodyMedium?.fontSize ?? 14) * scale,
                ),
              ),
            ),
            Row(
              children: [
                const Text('A', style: TextStyle(fontSize: 13)),
                Expanded(
                  child: Slider(
                    value: scale,
                    min: SettingsStore.minChatTextScale,
                    max: SettingsStore.maxChatTextScale,
                    divisions: 8,
                    label: '$percent%',
                    onChanged: onChanged,
                  ),
                ),
                const Text('A', style: TextStyle(fontSize: 22)),
              ],
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: scale == 1.0 ? null : () => onChanged(1.0),
                child: const Text('Reset'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AppLockCard extends StatelessWidget {
  const _AppLockCard({
    required this.enabled,
    required this.delay,
    required this.onToggle,
    required this.onDelayChanged,
  });

  final bool enabled;
  final AutoLockDelay delay;
  final ValueChanged<bool> onToggle;
  final ValueChanged<AutoLockDelay> onDelayChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          SwitchListTile(
            secondary: Icon(Icons.face, color: theme.colorScheme.primary),
            title: Text('Require Face ID'),
            subtitle: Text(
              'Lock the app and hide its content until you authenticate.',
            ),
            value: enabled,
            onChanged: onToggle,
          ),
          if (enabled) ...[
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Ask for Face ID',
                  style: theme.textTheme.labelLarge
                      ?.copyWith(color: context.tokens.muted),
                ),
              ),
            ),
            RadioGroup<AutoLockDelay>(
              groupValue: delay,
              onChanged: (v) {
                if (v != null) onDelayChanged(v);
              },
              child: Column(
                children: [
                  for (final option in AutoLockDelay.values)
                    RadioListTile<AutoLockDelay>(
                      dense: true,
                      title: Text(option.label),
                      value: option,
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _AppearanceCard extends StatelessWidget {
  const _AppearanceCard({required this.settings, required this.notifier});

  final AppSettings settings;
  final SettingsController notifier;

  // Brass leads because it is the design system's accent; the rest are cosmetic
  // overrides. Picking one repaints the accent group only — status colours stay
  // semantic, so a green accent can never be mistaken for "running".
  static const _accents = <int>[
    AppSettings.defaultAccentColor, // brass — the designed default
    0xFFF97316, // panda orange
    0xFF7AB7FF, // blue
    0xFF66C98B, // green
    0xFFB98BFF, // purple
    0xFFEF6A7A, // red
  ];

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Theme', style: Theme.of(context).textTheme.titleSmall),
            SizedBox(height: 8),
            SegmentedButton<AppThemeMode>(
              segments: const [
                ButtonSegment(
                    value: AppThemeMode.system, label: Text('System')),
                ButtonSegment(value: AppThemeMode.light, label: Text('Light')),
                ButtonSegment(value: AppThemeMode.dark, label: Text('Dark')),
              ],
              selected: {settings.themeMode},
              showSelectedIcon: false,
              onSelectionChanged: (s) => notifier.setThemeMode(s.first),
            ),
            SizedBox(height: 16),
            Text('Accent', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 12,
              children: [
                for (final c in _accents)
                  GestureDetector(
                    onTap: () => notifier.setAccentColor(c),
                    child: Container(
                      width: 30,
                      height: 30,
                      decoration: BoxDecoration(
                        color: Color(c),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: settings.accentColor == c
                              ? context.tokens.text
                              : Colors.transparent,
                          width: 2,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Compact density'),
              subtitle: const Text('Tighter spacing across the app'),
              value: settings.compactDensity,
              onChanged: notifier.setCompactDensity,
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Reduce motion'),
              subtitle: const Text('Minimize animations and transitions'),
              value: settings.reduceMotion,
              onChanged: notifier.setReduceMotion,
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatBehaviorCard extends StatelessWidget {
  const _ChatBehaviorCard({required this.settings, required this.notifier});

  final AppSettings settings;
  final SettingsController notifier;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          SwitchListTile(
            title: const Text('Auto-scroll'),
            subtitle: const Text('Follow new messages as they stream in'),
            value: settings.autoScroll,
            onChanged: notifier.setAutoScroll,
          ),
          const Divider(height: 1),
          SwitchListTile(
            title: const Text('Show thinking by default'),
            subtitle: const Text('Expand the agent’s reasoning blocks'),
            value: settings.showThinkingByDefault,
            onChanged: notifier.setShowThinking,
          ),
          const Divider(height: 1),
          SwitchListTile(
            title: const Text('Confirm before stopping'),
            subtitle: const Text('Ask before interrupting a session'),
            value: settings.confirmBeforeStop,
            onChanged: notifier.setConfirmBeforeStop,
          ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(Icons.code),
            title: const Text('Code theme'),
            trailing: TextButton(
              onPressed: () async {
                final picked = await showLabeledOptionSheet<String>(
                  context,
                  title: 'Code theme',
                  items: {for (final o in codeThemeOptions) o.id: o.label},
                  selected: settings.codeTheme,
                );
                if (picked != null) notifier.setCodeTheme(picked);
              },
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(codeThemeById(settings.codeTheme).label),
                  const SizedBox(width: 2),
                  const Icon(Icons.expand_more, size: 18),
                ],
              ),
            ),
          ),
          // Live preview of the selected code theme.
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: CodeView(
              code: 'void main() {\n  print("Panda Code");\n}',
              language: 'dart',
            ),
          ),
        ],
      ),
    );
  }
}

class _DefaultsCard extends StatelessWidget {
  const _DefaultsCard({required this.settings, required this.notifier});

  final AppSettings settings;
  final SettingsController notifier;

  @override
  Widget build(BuildContext context) {
    final runtime = settings.defaultRuntime == 'codex'
        ? AgentRuntime.codex
        : AgentRuntime.claude;
    final models = modelOptionsFor(runtime);
    final permissions = permissionOptionsFor(runtime);
    // Guard against a stored value that isn't in the current runtime's list.
    final modelValue = models.any((o) => o.value == settings.defaultModel)
        ? settings.defaultModel
        : '';
    final permValue =
        permissions.any((o) => o.value == settings.defaultPermission)
            ? settings.defaultPermission
            : permissions.first.value;

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Pre-fill the new-session sheet with these.',
                style: TextStyle(color: context.tokens.subtle, fontSize: 12.5)),
            const SizedBox(height: 8),
            _LabeledSelect<String>(
              label: 'Runtime',
              value: settings.defaultRuntime,
              items: const {'claude': 'Claude', 'codex': 'Codex'},
              onChanged: (v) {
                notifier.setDefaultRuntime(v);
                notifier
                    .setDefaultModel(''); // reset — lists differ per runtime
              },
            ),
            _LabeledSelect<String>(
              label: 'Model',
              value: modelValue,
              items: {for (final o in models) o.value: o.label},
              onChanged: notifier.setDefaultModel,
            ),
            _LabeledSelect<String>(
              label: runtime == AgentRuntime.codex ? 'Sandbox' : 'Permission',
              value: permValue,
              items: {for (final o in permissions) o.value: o.label},
              onChanged: notifier.setDefaultPermission,
            ),
          ],
        ),
      ),
    );
  }
}

/// Labeled single-select field. Raw Flutter dropdowns are forbidden in this app
/// (see analysis_options.yaml → avoid_raw_dropdown_widgets), so tapping this
/// opens a bottom-sheet picker instead of a floating menu.
class _LabeledSelect<T> extends StatelessWidget {
  const _LabeledSelect({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final String label;
  final T value;
  final Map<T, String> items;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final current = items.containsKey(value) ? value : items.keys.first;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        children: [
          SizedBox(
              width: 96,
              child:
                  Text(label, style: TextStyle(color: context.tokens.muted))),
          Expanded(
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () async {
                final picked = await showLabeledOptionSheet<T>(
                  context,
                  title: label,
                  items: items,
                  selected: current,
                );
                if (picked != null) onChanged(picked);
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(items[current] ?? '',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                    Icon(Icons.expand_more, color: theme.colorScheme.outline),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Bottom-sheet single-select picker shared across the settings screen. Mirrors
/// the create-session pickers so every selector in the app feels consistent.
Future<T?> showLabeledOptionSheet<T>(
  BuildContext context, {
  required String title,
  required Map<T, String> items,
  required T selected,
}) {
  final theme = Theme.of(context);
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 12),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: theme.colorScheme.outlineVariant,
              borderRadius: BorderRadius.circular(999),
            ),
          ),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(title,
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final entry = items.entries.elementAt(i);
                final isSelected = entry.key == selected;
                return Material(
                  color: theme.colorScheme.surface,
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => Navigator.of(context).pop(entry.key),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isSelected
                              ? theme.colorScheme.primary
                              : theme.colorScheme.outlineVariant,
                        ),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(entry.value,
                                style: TextStyle(
                                    fontSize: 15, fontWeight: FontWeight.w600)),
                          ),
                          SizedBox(width: 12),
                          if (isSelected)
                            Icon(Icons.check_circle,
                                color: theme.colorScheme.primary)
                          else
                            Icon(Icons.circle_outlined,
                                color: context.tokens.subtle),
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

class _NotificationsCard extends StatelessWidget {
  const _NotificationsCard({required this.settings, required this.notifier});

  final AppSettings settings;
  final SettingsController notifier;

  @override
  Widget build(BuildContext context) {
    final muted = settings.notificationsMuted;
    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          SwitchListTile(
            secondary: const Icon(Icons.notifications_off_outlined),
            title: const Text('Mute all notifications'),
            value: muted,
            onChanged: notifier.setNotificationsMuted,
          ),
          const Divider(height: 1),
          SwitchListTile(
            dense: true,
            title: const Text('Session finished'),
            value: settings.notifyOnDone && !muted,
            onChanged: muted ? null : notifier.setNotifyOnDone,
          ),
          SwitchListTile(
            dense: true,
            title: const Text('Needs approval'),
            value: settings.notifyOnNeedsApproval && !muted,
            onChanged: muted ? null : notifier.setNotifyOnNeedsApproval,
          ),
          SwitchListTile(
            dense: true,
            title: const Text('Errors'),
            value: settings.notifyOnError && !muted,
            onChanged: muted ? null : notifier.setNotifyOnError,
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Delivery is coordinated with your Mac; changes apply to newly '
                'started sessions.',
                style: TextStyle(color: context.tokens.subtle, fontSize: 11.5),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _UnpairCard extends StatelessWidget {
  const _UnpairCard({required this.deviceName, required this.onUnpair});

  final String? deviceName;
  final VoidCallback onUnpair;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: Icon(Icons.link_off, color: theme.colorScheme.error),
        title: const Text('Unsync this Mac'),
        subtitle: Text(
          deviceName == null
              ? 'Forget the pairing on this phone'
              : 'Forget the pairing with $deviceName',
        ),
        onTap: onUnpair,
      ),
    );
  }
}
