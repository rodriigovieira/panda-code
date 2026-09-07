import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/providers.dart';
import '../models.dart';

class NotificationChannelsSheet extends ConsumerStatefulWidget {
  const NotificationChannelsSheet({super.key, required this.row});
  final SessionRow row;

  @override
  ConsumerState<NotificationChannelsSheet> createState() => _NotificationChannelsSheetState();
}

class _NotificationChannelsSheetState extends ConsumerState<NotificationChannelsSheet> {
  Map<String, bool>? _channels;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => _update());
  }

  Future<void> _update({bool? desktop, bool? agent, bool? mobile}) async {
    if (!mounted || _busy) return;
    if (mobile == null && !ref.read(desktopOnlineProvider)) {
      setState(() => _error = 'Connect your Mac to manage desktop channels.');
      return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Relay is unavailable.');
      if (mobile != null) {
        await api.setSessionSubscription(widget.row.sessionId, subscribed: mobile);
      } else {
        final channels = await api.sessionNotificationChannels(widget.row.sessionId, desktop: desktop, agent: agent);
        if (mounted) setState(() => _channels = channels);
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = ref.watch(sessionRowProvider(widget.row.sessionId)) ?? widget.row;
    final online = ref.watch(desktopOnlineProvider);
    final canChangeDesktop = online && !_busy && _channels != null;
    return SafeArea(child: SingleChildScrollView(child: Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(
          title: const Text('Notification channels'),
          subtitle: const Text('Choose independently for this section. Turn all off for silence.'),
          trailing: IconButton(tooltip: 'Refresh settings', onPressed: _busy ? null : () => _update(), icon: const Icon(Icons.refresh)),
        ),
        if (_busy) const LinearProgressIndicator(),
        SwitchListTile(
          title: const Text('Mobile notifications'),
          subtitle: const Text('Push notifications on this phone'),
          secondary: const Icon(Icons.smartphone),
          value: row.subscribed,
          onChanged: _busy ? null : (value) => _update(mobile: value),
        ),
        SwitchListTile(
          title: const Text('Desktop notifications'),
          subtitle: const Text('System notification banners on your Mac'),
          secondary: const Icon(Icons.desktop_mac),
          value: _channels?['desktop'] ?? false,
          onChanged: canChangeDesktop ? (value) => _update(desktop: value) : null,
        ),
        SwitchListTile(
          title: const Text('Agent attention'),
          subtitle: const Text('On the Mac: sound, attention dialog, and bring Panda Code forward'),
          secondary: const Icon(Icons.notifications_active_outlined),
          value: _channels?['agent'] ?? false,
          onChanged: canChangeDesktop ? (value) => _update(agent: value) : null,
        ),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8), child: Text(
          'An explicit request you give the agent to use attention is still allowed when this switch is off. Global notification pauses and system permissions also apply to automatic alerts.',
        )),
        if (_error != null) Padding(padding: const EdgeInsets.all(16), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
      ]),
    )));
  }
}
