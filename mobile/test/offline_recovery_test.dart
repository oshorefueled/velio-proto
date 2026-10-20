import 'dart:async';
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

/// Offline reopening and safe recovery (ticket 06, US-09): previously loaded
/// invitation facts stay readable with their fetch time, an uncached code is
/// kept for Retry, nothing is claimed or queued offline, and fresh validity
/// and capacity are resolved before a new confirmation is possible.

const code = '2VKA1RPZ90S6';
const offline = SocketException('Network is unreachable');

class Device {
  Device() : directory = Directory.systemTemp.createTemp('velio-offline-');
  final Future<Directory> directory;

  /// A fresh app process over the same device files.
  ({InviteController controller, FakeTransport transport}) launch({List<FakeLiveSocket>? sockets}) {
    final transport = FakeTransport();
    final controller = InviteController(
      api: VelioApi(baseUrl: 'http://test', transport: transport.build()),
      store: DeviceStore(directory: () => directory),
      liveConnector: sockets == null
          ? null
          : () async {
              final socket = FakeLiveSocket();
              sockets.add(socket);
              return socket;
            },
    );
    return (controller: controller, transport: transport);
  }
}

Future<Device> deviceWithCachedPreview() async {
  final device = Device();
  final online = device.launch();
  online.transport.responses['GET /invites/$code'] = online.transport.previewBody(code: code);
  await online.controller.openCode(code);
  expect(online.controller.preview, isNotNull);
  expect(online.controller.cachedAt, isNull);
  await online.controller.store.save(); // let the cache write land before relaunch
  return device;
}

void main() {
  test('a previously loaded invitation reopens offline with its details, fetch time and out-of-date availability', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();

    final preview = app.controller.preview;
    expect(preview, isNotNull);
    expect(preview!.activity.title, 'Evening walk');
    expect(preview.plan.itinerary, 'Meet at the bridge.');
    expect(preview.host.displayName, 'River Host');
    expect(preview.inviterDisplayName, 'Inviter Name');
    expect(preview.expiresAt, '2026-12-01T18:00:00Z');
    expect(app.controller.cachedAt, isNotNull);
    expect(app.controller.availabilityStale, isTrue);
    expect(app.controller.resolveError, isNull);
  });

  test('an invitation never loaded on this device keeps its code for Retry when opened offline', () async {
    final app = Device().launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.openCode(code);
    expect(app.controller.preview, isNull);
    expect(app.controller.code, code);
    expect(app.controller.resolveError, contains('offline'));

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code);
    await app.controller.openCode(app.controller.code!);
    expect(app.controller.preview, isNotNull);
  });

  test('claiming from cached details asks for a connection and neither posts nor queues a booking', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();

    app.controller.continueToCheckout();
    expect(app.controller.checkout, isFalse);
    expect(app.controller.offlineNotice, contains('connection'));
    await app.controller.claim();
    expect(app.transport.requests.where((r) => r.method == 'POST'), isEmpty);
    expect((await app.controller.store.load()).operations, isEmpty);
    expect(app.controller.claimState, isA<ClaimIdle>());
  });

  test('when connectivity returns, fresh validity and capacity resolve before checkout, including a full activity', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    expect(app.controller.preview!.state, 'claimable');

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code, state: 'full');
    await app.controller.refreshPreview();
    expect(app.controller.cachedAt, isNull);
    expect(app.controller.offlineNotice, isNull);
    expect(app.controller.preview!.state, 'full');
    app.controller.continueToCheckout();
    expect(app.controller.checkout, isFalse);
  });

  test('a saved booking found on recovery wins over the refreshed invitation state', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    // Sign in while still offline-cached is not needed: a remembered account.
    app.transport.responses['POST /demo/sessions'] = jsonOf({
      'session': {'token': 'tok-1', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {'id': 'u1', 'email': 'guest@example.test', 'displayName': 'Guest'},
      'created': false,
    });
    app.transport.responses['GET /my/bookings'] = {'bookings': []};
    await app.controller.selectIdentity(email: 'guest@example.test', displayName: 'Guest');

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code, state: 'full');
    app.transport.responses['GET /activities/a1/bookings/me'] = app.transport.bookingBody();
    await app.controller.refreshPreview();
    expect(app.controller.claimState, isA<ClaimConfirmed>());
    expect(app.controller.consumeSuccessHaptic(), isFalse); // recovered, not new
  });

  test('a recovery refresh still pending when the account signs out cannot restore that account\'s booking', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    app.transport.responses['POST /demo/sessions'] = jsonOf({
      'session': {'token': 'tok-1', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {'id': 'u1', 'email': 'guest@example.test', 'displayName': 'Guest'},
      'created': false,
    });
    app.transport.responses['GET /my/bookings'] = {'bookings': []};
    await app.controller.selectIdentity(email: 'guest@example.test', displayName: 'Guest');

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code);
    final lookup = Completer<TransportResponse>();
    app.transport.deferred['GET /activities/a1/bookings/me'] = lookup;
    final refreshing = app.controller.refreshPreview();
    await pumpEventQueue();
    app.controller.signOut();
    lookup.complete(TransportResponse(status: 200, json: jsonOf(app.transport.bookingBody())));
    await refreshing;
    expect(app.controller.session, isNull);
    expect(app.controller.claimState, isA<ClaimIdle>());
    expect(app.transport.requests.where((r) => r.method == 'POST' && r.path.endsWith('/bookings')), isEmpty);
  });

  test('a claim whose response and booking lookup are both lost stays checking, without a second booking or haptic', () async {
    final app = Device().launch();
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code);
    app.transport.responses['POST /demo/sessions'] = jsonOf({
      'session': {'token': 'tok-1', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {'id': 'u1', 'email': 'guest@example.test', 'displayName': 'Guest'},
      'created': false,
    });
    app.transport.responses['GET /my/bookings'] = {'bookings': []};
    app.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    app.transport.responses['GET /activities/a1/bookings/me'] = app.transport.errorBody('booking_not_found');
    await app.controller.openCode(code);
    await app.controller.selectIdentity(email: 'guest@example.test', displayName: 'Guest');
    app.controller.continueToCheckout();

    app.transport.errors['POST /activities/a1/bookings'] = offline;
    app.transport.errors['GET /activities/a1/bookings/me'] = offline;
    await app.controller.claim();
    expect(app.controller.claimState, isA<ClaimUnknown>());
    await app.controller.claim(); // a tap while uncertain checks, never re-posts
    expect(app.transport.requests.where((r) => r.method == 'POST' && r.path.endsWith('/bookings')), hasLength(1));
    expect(app.controller.claimState, isNot(isA<ClaimRefused>()));
    expect(app.controller.consumeSuccessHaptic(), isFalse);
  });

  test('cached facts refresh once the live connection is re-established, and on foreground return', () async {
    final device = await deviceWithCachedPreview();
    final sockets = <FakeLiveSocket>[];
    final app = device.launch(sockets: sockets);
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    await pumpEventQueue();
    expect(app.controller.cachedAt, isNotNull);

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = app.transport.previewBody(code: code);
    sockets.last.receive({'type': 'subscribed', 'activityId': 'a1'});
    await pumpEventQueue();
    expect(app.controller.cachedAt, isNull);

    // Foreground return also re-resolves facts that are still cached.
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.openCode(code);
    await pumpEventQueue();
    expect(app.controller.cachedAt, isNotNull);
    app.controller.setForeground(false);
    app.transport.errors.remove('GET /invites/$code');
    app.controller.setForeground(true);
    await pumpEventQueue();
    expect(app.controller.cachedAt, isNull);
    app.controller.dispose();
  });

  testWidgets('the offline preview shows its saved time and explains that claiming needs a connection', (tester) async {
    tzdata.initializeTimeZones();
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final transport = FakeTransport();
    final controller = InviteController(
      api: VelioApi(baseUrl: 'http://test', transport: transport.build()),
      store: DeviceStore.inMemory(),
    );
    transport.responses['GET /invites/$code'] = transport.previewBody(code: code);
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: controller)));
    unawaited(controller.openCode(code));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('offline-banner')), findsNothing);

    transport.errors['GET /invites/$code'] = offline;
    unawaited(controller.openCode(code));
    await tester.pump();
    await tester.pump();
    expect(find.text('Evening walk'), findsOneWidget);
    expect(find.byKey(const Key('offline-banner')), findsOneWidget);
    expect(find.textContaining('Saved'), findsOneWidget);
    expect(find.byKey(const Key('availability-stale')), findsOneWidget);

    await tester.tap(find.byKey(const Key('continue-checkout')));
    await tester.pump();
    expect(find.textContaining('A connection is required'), findsOneWidget);
    expect(find.text('Review your booking'), findsNothing);
  });

  test('recovered capacity renders at once through the live owner and is acknowledged as a reconnect snapshot', () async {
    final device = await deviceWithCachedPreview();
    final sockets = <FakeLiveSocket>[];
    final app = device.launch(sockets: sockets);
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    await pumpEventQueue();
    sockets.last.receive({'type': 'measurement_registered', 'connectionId': 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'});

    app.transport.errors.remove('GET /invites/$code');
    app.transport.responses['GET /invites/$code'] = jsonOf(app.transport.previewBody(code: code)
        .replaceAll('"bookedCount":1,"remainingSpots":1,"availabilityVersion":"4"', '"bookedCount":2,"remainingSpots":0,"availabilityVersion":"9"'));
    await app.controller.refreshPreview();
    expect(app.controller.cachedAt, isNull);
    expect(app.controller.preview!.activity.availabilityVersion, '9');
    expect(app.controller.preview!.activity.remainingSpots, 0);
    expect(app.controller.preview!.state, 'full');
    app.controller.noteAvailabilityRendered();
    await pumpEventQueue();
    final ack = app.transport.requests.singleWhere((r) => r.path == '/availability-acks');
    expect(ack.body, contains('"source":"snapshot"'));
    expect(ack.body, contains('"reason":"reconnect"'));
    app.controller.dispose();
  });

  test('a server answer during recovery ends the offline state instead of blaming the connection', () async {
    final device = await deviceWithCachedPreview();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    app.transport.errors.remove('GET /invites/$code');
    app.transport.statusOverrides['GET /invites/$code'] = 429;
    app.transport.responses['GET /invites/$code'] = app.transport.errorBody('request_limit');
    await app.controller.refreshPreview();
    expect(app.controller.cachedAt, isNull);
    expect(app.controller.offlineNotice, isNull);
    expect(app.controller.resolveError, 'request_limit');
  });

  test('a cached invitation whose deadline has passed reopens offline as expired', () async {
    final device = Device();
    final online = device.launch();
    online.transport.responses['GET /invites/$code'] = online.transport.previewBody(code: code)
        .replaceAll('"expiresAt":"2026-12-01T18:00:00Z"', '"expiresAt":"2020-01-01T00:00:00Z"');
    await online.controller.openCode(code);
    await online.controller.store.save();
    final app = device.launch();
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.openCode(code);
    expect(app.controller.preview!.state, 'expired');
  });

  test('a damaged cache entry is dropped without losing the remembered account or pending operations', () {
    final device = StoredDevice.fromJson({
      'visitorId': 'v1',
      'session': {'token': 't', 'userId': 'u1', 'displayName': 'Guest', 'email': 'guest@example.test'},
      'operations': {'u1:a1': {'operationId': 'op-1', 'inviteCode': code}},
      'previews': {'BROKEN': {'json': 'not a map'}, code: {'json': {'invite': {}}, 'fetchedAt': '2026-10-20T00:00:00Z'}},
    });
    expect(device.session!.userId, 'u1');
    expect(device.operations['u1:a1']!.operationId, 'op-1');
    expect(device.previews.keys, [code]);
  });

  test('counts applied live while the recovery resolve is in flight are not rolled back to the cached ones', () async {
    final device = await deviceWithCachedPreview();
    final sockets = <FakeLiveSocket>[];
    final app = device.launch(sockets: sockets);
    app.transport.errors['GET /invites/$code'] = offline;
    await app.controller.bootstrap();
    await pumpEventQueue();

    app.transport.errors.remove('GET /invites/$code');
    final resolve = Completer<TransportResponse>();
    app.transport.deferred['GET /invites/$code'] = resolve;
    final refreshing = app.controller.refreshPreview();
    await pumpEventQueue();
    sockets.last.receive({'type': 'availability', 'activityId': 'a1', 'version': '9', 'remainingSpots': 0, 'eventId': null});
    await pumpEventQueue();
    resolve.complete(TransportResponse(status: 200, json: jsonOf(app.transport.previewBody(code: code, state: 'full')
        .replaceAll('"bookedCount":1,"remainingSpots":1,"availabilityVersion":"4"', '"bookedCount":2,"remainingSpots":0,"availabilityVersion":"9"'))));
    await refreshing;
    expect(app.controller.preview!.activity.availabilityVersion, '9');
    expect(app.controller.preview!.activity.remainingSpots, 0);
    app.controller.dispose();
  });
}
