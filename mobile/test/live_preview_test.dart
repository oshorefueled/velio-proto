import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_screen.dart';

import 'invite_controller_test.dart' show FakeTransport, jsonOf;
import 'live_availability_test.dart' show FakeLiveSocket;

/// The invitation preview binds one live owner to its activity (SPEC C5):
/// committed availability renders without manual refresh, an older database
/// read never regresses it, and a replaced code closes the old owner.

const code = '2VKA1RPZ90S6';
const connectionId = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

String activityBody({required String version, required int remaining}) => jsonEncode({
  'activity': {
    'id': 'a1', 'title': 'Evening walk', 'description': 'Walk beside the river.',
    'startsAt': '2026-12-01T18:00:00Z', 'timezone': 'Europe/Stockholm', 'priceMinorUnits': 1200,
    'currency': 'EUR', 'capacity': 2, 'bookedCount': 2 - remaining, 'remainingSpots': remaining,
    'availabilityVersion': version,
  },
  'plan': {'id': 'p1', 'activityId': 'a1', 'itinerary': 'Meet at the bridge.'},
  'host': {'id': 'h1', 'displayName': 'River Host', 'summary': '', 'previousActivities': []},
});

class LiveHarness {
  LiveHarness({DeviceStore? store}) {
    transport.responses['GET /invites/$code'] = transport.previewBody(code: code);
    controller = InviteController(
      api: VelioApi(baseUrl: 'http://test', transport: transport.build()),
      store: store ?? DeviceStore(directory: () => Directory.systemTemp.createTemp('velio-live-')),
      liveConnector: () async {
        final socket = FakeLiveSocket();
        sockets.add(socket);
        return socket;
      },
    );
  }
  final transport = FakeTransport();
  final sockets = <FakeLiveSocket>[];
  late final InviteController controller;

  Future<void> openLive() async {
    await controller.openCode(code);
    await pumpEventQueue();
    sockets.last.receive({'type': 'measurement_registered', 'connectionId': connectionId});
    sockets.last.receive({'type': 'subscribed', 'activityId': 'a1'});
    await pumpEventQueue();
  }

  List<Map<String, dynamic>> get acks => transport.requests
      .where((request) => request.path == '/availability-acks')
      .map((request) => jsonDecode(request.body!) as Map<String, dynamic>)
      .toList();
}

void main() {
  test('a committed booking elsewhere renders on the preview and is acknowledged only after render', () async {
    final h = LiveHarness();
    await h.openLive();
    expect(h.sockets.last.sent.last, {'type': 'subscribe', 'activityId': 'a1'});

    h.sockets.last.receive({'type': 'availability', 'activityId': 'a1', 'version': '6', 'remainingSpots': 0, 'eventId': null});
    await pumpEventQueue();
    final activity = h.controller.preview!.activity;
    expect(activity.availabilityVersion, '6');
    expect(activity.remainingSpots, 0);
    expect(activity.bookedCount, 2);
    expect(h.acks, isEmpty);

    h.controller.noteAvailabilityRendered();
    await pumpEventQueue();
    expect(h.acks, hasLength(1));
    expect(h.acks.single, containsPair('appliedVersion', '6'));
    expect(h.acks.single, containsPair('source', 'websocket'));
    expect(h.acks.single, containsPair('connectionId', connectionId));
    h.controller.dispose();
  });

  test('a live update to no remaining spots reads as full, and an older activity snapshot never regresses it', () async {
    final h = LiveHarness();
    await h.openLive();
    expect(h.controller.preview!.state, 'claimable');
    h.sockets.last.receive({'type': 'availability', 'activityId': 'a1', 'version': '6', 'remainingSpots': 0, 'eventId': null});
    await pumpEventQueue();
    expect(h.controller.preview!.state, 'full');

    // The snapshot reads the public activity (version 4, older) — never the
    // quota-bounded invitation resolve.
    final resolves = h.transport.requests.where((r) => r.path == '/invites/$code').length;
    h.transport.responses['GET /activities/a1'] = activityBody(version: '4', remaining: 1);
    h.sockets.last.receive({'type': 'resnapshot'});
    await pumpEventQueue();
    expect(h.transport.requests.where((r) => r.path == '/activities/a1'), isNotEmpty);
    expect(h.transport.requests.where((r) => r.path == '/invites/$code').length, resolves);
    expect(h.controller.preview!.activity.availabilityVersion, '6');
    expect(h.controller.preview!.activity.remainingSpots, 0);
    expect(h.controller.preview!.state, 'full');
    h.controller.dispose();
  });

  test('opening another code closes the previous activity owner', () async {
    final h = LiveHarness();
    await h.openLive();
    final first = h.sockets.last;
    h.transport.responses['GET /invites/OTHERCODE123'] = jsonOf(
      h.transport.previewBody(code: 'OTHERCODE123', activityId: 'b2'),
    );
    await h.controller.openCode('OTHERCODE123');
    await pumpEventQueue();
    expect(first.closed, isTrue);
    expect(h.sockets.last.sent.last, {'type': 'subscribe', 'activityId': 'b2'});
    h.controller.dispose();
  });

  testWidgets('the rendered preview shows the live count, acknowledges it after rendering and flags a lost connection', (tester) async {
    tzdata.initializeTimeZones();
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final h = LiveHarness(store: DeviceStore.inMemory());
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: h.controller)));
    // Inside the widget clock, frames and microtasks advance through pump.
    unawaited(h.controller.openCode(code));
    await tester.pump();
    await tester.pump();
    h.sockets.last.receive({'type': 'measurement_registered', 'connectionId': connectionId});
    h.sockets.last.receive({'type': 'subscribed', 'activityId': 'a1'});
    await tester.pump();
    expect(find.text('1 of 2 spots left'), findsOneWidget);

    h.sockets.last.receive({'type': 'availability', 'activityId': 'a1', 'version': '6', 'remainingSpots': 0, 'eventId': null});
    expect(h.acks, isEmpty); // no frame has rendered the new version yet
    await tester.pump();
    expect(find.text('0 of 2 spots left'), findsOneWidget);
    await tester.pump();
    expect(h.acks.map((ack) => ack['appliedVersion']), ['6']);

    h.sockets.last.drop();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('availability-stale')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    h.controller.dispose();
  });
}
