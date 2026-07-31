import 'dart:convert';

import 'package:convex_flutter/convex_flutter.dart';

/// Thin wrapper over the Convex client that encodes the arg convention used by the
/// patched `convex_flutter`:
///   - query / subscribe args are `Map<String,String>`, each value `jsonEncode`d.
///   - mutation args are `Map<String,dynamic>` (the package json-encodes internally).
/// Results come back as JSON strings; we decode them here.
class RelayClient {
  final ConvexClient _client;

  RelayClient(this._client);

  static Future<RelayClient>? _initializing;

  static Future<RelayClient> initialize(String deploymentUrl) async {
    await ConvexClient.initialize(
      ConvexConfig(deploymentUrl: deploymentUrl, clientId: 'panda-code-mobile'),
    );
    return RelayClient(ConvexClient.instance);
  }

  /// Initialize, or reuse the existing singleton if already initialized
  /// (the ConvexClient is a process-wide singleton).
  static Future<RelayClient> ensureInitialized(String deploymentUrl) async {
    final normalizedUrl = deploymentUrl.trim();
    try {
      final existing = ConvexClient.instance;
      if (existing.config.deploymentUrl == normalizedUrl) {
        return RelayClient(existing);
      }
      ConvexClient.resetInstance();
    } on StateError {
      // Not initialized yet.
    }

    final inFlight = _initializing;
    if (inFlight != null) return inFlight;

    final init = initialize(normalizedUrl);
    _initializing = init;
    try {
      return await init;
    } on StateError catch (error) {
      // Another caller may have initialized between our optimistic check and
      // ConvexClient.initialize(). Reuse it only if it really exists.
      if (error.message == 'ConvexClient already initialized') {
        return RelayClient(ConvexClient.instance);
      }
      rethrow;
    } finally {
      if (identical(_initializing, init)) _initializing = null;
    }
  }

  static void reset() {
    _initializing = null;
    ConvexClient.resetInstance();
  }

  Map<String, String> _encodeArgs(Map<String, dynamic> args) => {
        for (final e in args.entries)
          if (e.value != null) e.key: jsonEncode(e.value),
      };

  dynamic _decode(String json) => json.isEmpty ? null : jsonDecode(json);

  Future<dynamic> query(String name, Map<String, dynamic> args) async =>
      _decode(await _client.query(name, _encodeArgs(args)));

  Future<dynamic> mutation(String name, Map<String, dynamic> args) async =>
      _decode(await _client.mutation(name: name, args: args));

  Future<RelaySubscription> subscribe(
    String name,
    Map<String, dynamic> args, {
    required void Function(dynamic value) onData,
    void Function(String message)? onError,
  }) async {
    final handle = await _client.subscribe(
      name: name,
      args: _encodeArgs(args),
      onUpdate: (json) => onData(_decode(json)),
      onError: (message, _) => onError?.call(message),
    );
    return RelaySubscription(handle);
  }
}

/// Cancelable subscription handle.
class RelaySubscription {
  final SubscriptionHandle _handle;

  RelaySubscription(this._handle);

  void cancel() => _handle.cancel();
}
