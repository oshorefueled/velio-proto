import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// One live-availability owner per visible activity (SPEC C5), the Flutter
/// counterpart of web/src/live/availability.ts. It registers measurement and
/// subscribes on GET /live, fetches a database snapshot only after the
/// subscription is acknowledged, applies only strictly newer versions
/// (BigInt — never double), refetches on `resnapshot`, reconnect, foreground
/// return and every five seconds while foregrounded, and reconnects with a
/// bounded backoff. Live facts never confirm or replay a booking.
///
/// An application is acknowledged only after the UI reports that it rendered
/// that version ([markRendered]); a superseded application is never
/// acknowledged late, a replaced socket's callbacks never act, and a failed
/// acknowledgement never affects the displayed facts.

abstract class LiveSocket {
  Stream<String> get frames;
  void send(String data);
  void close();
}

typedef LiveConnector = Future<LiveSocket> Function();

class LiveFacts {
  const LiveFacts({required this.version, required this.remainingSpots});
  final String version;
  final int remainingSpots;
}

class LiveApplication {
  const LiveApplication({
    required this.version,
    required this.remainingSpots,
    required this.source,
    required this.reason,
    required this.eventId,
    required this.seq,
  });
  final String version;
  final int remainingSpots;

  /// `websocket` or `snapshot`.
  final String source;

  /// `interval`, `reconnect` or `foreground`.
  final String reason;
  final String? eventId;
  final int seq;
}

class AvailabilityAck {
  const AvailabilityAck({
    required this.connectionId,
    required this.activityId,
    required this.appliedVersion,
    required this.source,
    required this.reason,
    this.appliedEventId,
  });
  final String connectionId;
  final String activityId;
  final String appliedVersion;
  final String? appliedEventId;
  final String source;
  final String reason;
}

enum LiveConnection { connecting, live, reconnecting }

final _versionPattern = RegExp(r'^[0-9]{1,19}$');

/// Arbitrary-precision ordering; an unparsable version is never newer.
int compareVersions(String a, String b) {
  final left = BigInt.tryParse(a);
  final right = BigInt.tryParse(b);
  if (left == null || right == null) return -1;
  return left.compareTo(right);
}

/// The API base mapped to its WebSocket endpoint.
Uri liveSocketUri(String baseUrl) {
  final base = Uri.parse(baseUrl);
  final path = base.path.endsWith('/')
      ? base.path.substring(0, base.path.length - 1)
      : base.path;
  return base.replace(
    scheme: base.scheme == 'https' ? 'wss' : 'ws',
    path: '$path/live',
  );
}

/// Production dart:io socket for [LiveAvailability].
LiveConnector ioLiveConnector(String baseUrl) => () async {
  final pending = WebSocket.connect(liveSocketUri(baseUrl).toString());
  try {
    final socket = await pending.timeout(const Duration(seconds: 10));
    // Pings detect a half-open connection (e.g. after a network handover).
    socket.pingInterval = const Duration(seconds: 10);
    return _IoLiveSocket(socket);
  } on TimeoutException {
    // A handshake finishing after the timeout is closed, never leaked.
    unawaited(pending.then((late) => late.close(), onError: (Object _) {}));
    rethrow;
  }
};

class _IoLiveSocket implements LiveSocket {
  _IoLiveSocket(this._socket);
  final WebSocket _socket;

  @override
  Stream<String> get frames =>
      _socket.where((data) => data is String).cast<String>();

  @override
  void send(String data) => _socket.add(data);

  @override
  void close() => unawaited(_socket.close());
}

class LiveAvailability extends ChangeNotifier {
  LiveAvailability({
    required this.activityId,
    required String displayedVersion,
    required this.connect,
    required this.loadSnapshot,
    required this.postAck,
    this._foreground = true,
  }) : _version = displayedVersion;

  final String activityId;
  final LiveConnector connect;
  final Future<LiveFacts> Function() loadSnapshot;
  final Future<void> Function(AvailabilityAck ack) postAck;

  static const refreshInterval = Duration(seconds: 5);

  /// The newest version known to this owner (initially the displayed one).
  String _version;
  LiveApplication? _applied;
  LiveApplication? _pendingAck;
  LiveConnection _connection = LiveConnection.connecting;
  bool _stale = false;
  bool _foreground;
  String? _connectionId;

  /// The last capability this viewer was issued; a replacement socket
  /// presents it so the server keeps one viewer across reconnects.
  String? _previousConnectionId;
  String _lifecycleReason = 'reconnect';
  int _seq = 0;
  int _socketRun = 0;
  int _snapshotRun = 0;
  int _retryAttempt = 0;
  bool _disposed = false;
  LiveSocket? _socket;
  StreamSubscription<String>? _subscription;
  Timer? _retryTimer;
  Timer? _refreshTimer;

  LiveApplication? get applied => _applied;
  LiveConnection get connection => _connection;

  /// Known loss or a failed refresh: displayed availability may be out of date.
  bool get stale => _stale;

  void start() {
    _startSocket();
    if (_foreground) _startRefreshTimer();
  }

  /// App lifecycle: foreground return refreshes from the database at once;
  /// background stops the periodic refresh and reports the viewer hidden.
  void setForeground(bool foreground) {
    if (_disposed || foreground == _foreground) return;
    _foreground = foreground;
    _sendFrame({'type': 'visibility', 'visible': foreground});
    if (foreground) {
      _lifecycleReason = 'foreground';
      if (_connection != LiveConnection.live) _startSocket();
      _startRefreshTimer();
      _fetchSnapshot('foreground');
    } else {
      _refreshTimer?.cancel();
      _refreshTimer = null;
    }
  }

  /// A database read made outside this owner (e.g. reconnect recovery of
  /// cached facts) is applied like the owner's own snapshot: only if newer.
  void adoptSnapshot(LiveFacts facts, {required String reason}) {
    if (_disposed || compareVersions(facts.version, _version) <= 0) return;
    _apply(
      LiveApplication(
        version: facts.version,
        remainingSpots: facts.remainingSpots,
        source: 'snapshot',
        reason: reason,
        eventId: null,
        seq: ++_seq,
      ),
    );
  }

  /// The UI rendered [displayedVersion]: acknowledge the newest pending
  /// application only when that is exactly its version.
  void markRendered(String displayedVersion) {
    final pending = _pendingAck;
    final connectionId = _connectionId;
    if (pending == null || connectionId == null) return;
    if (pending.version != displayedVersion) return;
    _pendingAck = null;
    unawaited(
      postAck(
        AvailabilityAck(
          connectionId: connectionId,
          activityId: activityId,
          appliedVersion: pending.version,
          appliedEventId: pending.eventId,
          source: pending.source,
          reason: pending.reason,
        ),
      ).catchError((_) {}),
    );
  }

  void _apply(LiveApplication application) {
    _version = application.version;
    _applied = application;
    _pendingAck = application;
    _stale = false;
    notifyListeners();
  }

  void _fetchSnapshot(String reason) {
    if (_disposed) return;
    final run = ++_snapshotRun;
    unawaited(
      loadSnapshot().then(
        (facts) {
          if (_disposed || run != _snapshotRun) return;
          if (compareVersions(facts.version, _version) <= 0) {
            // Equal or older database state: counts stay, and a successful
            // database read is the reconciliation that clears staleness.
            if (_stale) {
              _stale = false;
              notifyListeners();
            }
            return;
          }
          _apply(
            LiveApplication(
              version: facts.version,
              remainingSpots: facts.remainingSpots,
              source: 'snapshot',
              reason: reason,
              eventId: null,
              seq: ++_seq,
            ),
          );
        },
        onError: (Object _) {
          if (_disposed || run != _snapshotRun) return;
          if (!_stale) {
            _stale = true;
            notifyListeners();
          }
        },
      ),
    );
  }

  void _handleFrame(String raw) {
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final frame = decoded.cast<String, Object?>();
    switch (frame['type']) {
      case 'measurement_registered':
        final id = frame['connectionId'];
        if (id is String) _connectionId = _previousConnectionId = id;
      case 'subscribed':
        if (frame['activityId'] != activityId) return;
        _retryAttempt = 0;
        _setConnection(LiveConnection.live);
        // Subscribe first; the snapshot window opens only on the established
        // subscription, so no commit can slip between the two.
        _fetchSnapshot(_lifecycleReason);
      case 'resnapshot':
        _fetchSnapshot('reconnect');
      case 'availability':
        final version = frame['version'];
        final remaining = frame['remainingSpots'];
        final event = frame['eventId'];
        if (frame['activityId'] != activityId ||
            version is! String ||
            !_versionPattern.hasMatch(version) ||
            remaining is! int ||
            remaining < 0 ||
            (event != null && event is! String)) {
          return;
        }
        if (compareVersions(version, _version) <= 0) return;
        _apply(
          LiveApplication(
            version: version,
            remainingSpots: remaining,
            source: 'websocket',
            reason: _lifecycleReason,
            eventId: event as String?,
            seq: ++_seq,
          ),
        );
    }
  }

  void _startSocket() {
    _retryTimer?.cancel();
    _retryTimer = null;
    _closeSocket();
    final run = ++_socketRun;
    _connectionId = null;
    unawaited(
      connect().then(
        (socket) {
          if (_disposed || run != _socketRun) {
            socket.close();
            return;
          }
          _socket = socket;
          _subscription = socket.frames.listen(
            (raw) {
              if (!_disposed && run == _socketRun) _handleFrame(raw);
            },
            onDone: () {
              if (!_disposed && run == _socketRun) _lost();
            },
            onError: (Object _) {},
            cancelOnError: false,
          );
          try {
            socket.send(
              jsonEncode({
                'type': 'register_measurement',
                'visible': _foreground,
                'previousConnectionId': ?_previousConnectionId,
              }),
            );
            socket.send(
              jsonEncode({'type': 'subscribe', 'activityId': activityId}),
            );
          } catch (_) {
            // A closing socket is recovered by its done handler.
          }
        },
        onError: (Object _) {
          if (!_disposed && run == _socketRun) _lost();
        },
      ),
    );
  }

  void _lost() {
    _socket = null;
    _subscription = null;
    _connectionId = null; // A replacement socket registers anew.
    _lifecycleReason = 'reconnect';
    _connection = LiveConnection.reconnecting;
    _stale = true;
    notifyListeners();
    final delay = Duration(milliseconds: (1000 * (1 << _retryAttempt)).clamp(1000, 5000));
    if (_retryAttempt < 3) _retryAttempt += 1;
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (!_disposed) _startSocket();
    });
  }

  void _startRefreshTimer() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer.periodic(refreshInterval, (_) {
      if (_foreground) _fetchSnapshot('interval');
    });
  }

  void _sendFrame(Map<String, Object?> frame) {
    final socket = _socket;
    if (socket == null || _connectionId == null) return;
    try {
      socket.send(jsonEncode(frame));
    } catch (_) {
      // Recovered by the done handler.
    }
  }

  void _setConnection(LiveConnection connection) {
    if (_connection == connection) return;
    _connection = connection;
    notifyListeners();
  }

  void _closeSocket() {
    final socket = _socket;
    _socket = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    socket?.close();
  }

  @override
  void dispose() {
    _disposed = true;
    _socketRun += 1;
    _snapshotRun += 1;
    _retryTimer?.cancel();
    _refreshTimer?.cancel();
    _closeSocket();
    super.dispose();
  }
}
