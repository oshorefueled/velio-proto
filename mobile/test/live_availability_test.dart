import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:velio/live_availability.dart';

class FakeLiveSocket implements LiveSocket {
  final sent = <Map<String, dynamic>>[];
  final _frames = StreamController<String>();
  bool closed = false;

  @override
  Stream<String> get frames => _frames.stream;

  @override
  void send(String data) => sent.add(jsonDecode(data) as Map<String, dynamic>);

  @override
  void close() {
    closed = true;
    _frames.close();
  }

  void receive(Map<String, Object?> frame) => _frames.add(jsonEncode(frame));

  /// The server or network dropped the connection.
  void drop() => _frames.close();
}

const activityId = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const connectionId = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const eventId = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

class Harness {
  Harness({String displayedVersion = '5'}) {
    live = LiveAvailability(
      activityId: activityId,
      displayedVersion: displayedVersion,
      connect: () async {
        final socket = FakeLiveSocket();
        sockets.add(socket);
        return socket;
      },
      loadSnapshot: () async {
        snapshotCalls += 1;
        final next = snapshot;
        if (next == null) throw StateError('offline');
        return next;
      },
      postAck: (ack) async => acks.add(ack),
    );
  }

  late final LiveAvailability live;
  final sockets = <FakeLiveSocket>[];
  final acks = <AvailabilityAck>[];
  int snapshotCalls = 0;
  LiveFacts? snapshot = const LiveFacts(version: '5', remainingSpots: 3);

  FakeLiveSocket get socket => sockets.last;

  /// Registration and subscription acknowledged by the server.
  void establish() {
    socket.receive({'type': 'measurement_registered', 'connectionId': connectionId});
    socket.receive({'type': 'subscribed', 'activityId': activityId});
  }
}

void main() {
  test('subscribes and registers before fetching the first snapshot, then renders only a newer snapshot', () {
    fakeAsync((async) {
      final h = Harness();
      h.live.start();
      async.flushMicrotasks();
      expect(h.socket.sent.map((frame) => frame['type']), ['register_measurement', 'subscribe']);
      expect(h.socket.sent.last['activityId'], activityId);
      expect(h.snapshotCalls, 0);

      h.snapshot = const LiveFacts(version: '6', remainingSpots: 2);
      h.establish();
      async.flushMicrotasks();
      expect(h.snapshotCalls, 1);
      expect(h.live.applied!.version, '6');
      expect(h.live.applied!.remainingSpots, 2);
      expect(h.live.applied!.source, 'snapshot');
      h.live.dispose();
    });
  });

  test('acknowledges a websocket version only after it renders, once, and ignores older or duplicate frames', () {
    fakeAsync((async) {
      final h = Harness();
      h.live.start();
      async.flushMicrotasks();
      h.establish();
      async.flushMicrotasks();
      expect(h.live.applied, isNull); // the equal snapshot is not a new display

      h.socket.receive({'type': 'availability', 'activityId': activityId, 'version': '7', 'remainingSpots': 1, 'eventId': eventId});
      async.flushMicrotasks();
      expect(h.live.applied!.version, '7');
      expect(h.acks, isEmpty); // message receipt alone never acknowledges

      h.live.markRendered('5'); // an older render is not this version
      async.flushMicrotasks();
      expect(h.acks, isEmpty);
      h.live.markRendered('7');
      h.live.markRendered('7');
      async.flushMicrotasks();
      expect(h.acks, hasLength(1));
      expect(h.acks.single.connectionId, connectionId);
      expect(h.acks.single.appliedVersion, '7');
      expect(h.acks.single.appliedEventId, eventId);
      expect(h.acks.single.source, 'websocket');

      for (final version in ['6', '7']) {
        h.socket.receive({'type': 'availability', 'activityId': activityId, 'version': version, 'remainingSpots': 2, 'eventId': null});
      }
      async.flushMicrotasks();
      expect(h.live.applied!.version, '7');
      expect(h.live.applied!.remainingSpots, 1);
      h.live.markRendered('7');
      async.flushMicrotasks();
      expect(h.acks, hasLength(1));
      h.live.dispose();
    });
  });

  test('after a dropped connection it reconnects and records the missed booking as a reconnect snapshot', () {
    fakeAsync((async) {
      final h = Harness();
      h.live.start();
      async.flushMicrotasks();
      h.establish();
      async.flushMicrotasks();

      h.socket.drop();
      async.flushMicrotasks();
      expect(h.live.stale, isTrue);
      expect(h.live.connection, LiveConnection.reconnecting);

      h.snapshot = const LiveFacts(version: '8', remainingSpots: 0);
      async.elapse(const Duration(seconds: 1));
      expect(h.sockets, hasLength(2));
      // The same viewer re-registers with its earlier capability.
      expect(h.socket.sent.first, {'type': 'register_measurement', 'visible': true, 'previousConnectionId': connectionId});
      expect(h.sockets.first.sent.first.containsKey('previousConnectionId'), isFalse);
      h.establish();
      async.flushMicrotasks();
      expect(h.live.stale, isFalse);
      expect(h.live.applied!.version, '8');
      h.live.markRendered('8');
      async.flushMicrotasks();
      expect(h.acks.single.source, 'snapshot');
      expect(h.acks.single.reason, 'reconnect');
      expect(h.acks.single.appliedEventId, isNull);
      h.live.dispose();
    });
  });

  test('refreshes every five seconds only while foregrounded, and at once on foreground return or resnapshot', () {
    fakeAsync((async) {
      final h = Harness();
      h.live.start();
      async.flushMicrotasks();
      h.establish();
      async.flushMicrotasks();
      expect(h.snapshotCalls, 1);

      h.snapshot = const LiveFacts(version: '6', remainingSpots: 2);
      async.elapse(const Duration(seconds: 5));
      expect(h.snapshotCalls, 2);
      expect(h.live.applied!.reason, 'interval');

      h.live.setForeground(false);
      expect(h.socket.sent.last, {'type': 'visibility', 'visible': false});
      async.elapse(const Duration(seconds: 20));
      expect(h.snapshotCalls, 2);

      h.snapshot = const LiveFacts(version: '9', remainingSpots: 1);
      h.live.setForeground(true);
      async.flushMicrotasks();
      expect(h.snapshotCalls, 3);
      expect(h.live.applied!.reason, 'foreground');

      h.socket.receive({'type': 'resnapshot'});
      async.flushMicrotasks();
      expect(h.snapshotCalls, 4);
      h.live.dispose();
    });
  });

  test('a disposed owner ignores late snapshots and frames', () {
    fakeAsync((async) {
      final h = Harness();
      h.live.start();
      async.flushMicrotasks();
      h.establish();
      h.live.dispose();
      async.flushMicrotasks();
      expect(h.live.applied, isNull);
      expect(h.socket.closed, isTrue);
      async.elapse(const Duration(seconds: 30));
      expect(h.snapshotCalls, lessThanOrEqualTo(1));
    });
  });
}
