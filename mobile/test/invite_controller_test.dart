import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';

/// Controller lifecycle regressions (issue #19): preview before identity,
/// stale code replacement, persistent identity with old-401 protection,
/// explicit claim with stable operation + bound code, uncertainty recovery
/// (unknown never invents failure), Retry-After, receipt precedence over an
/// unusable invite, one-shot success haptics, and display telemetry with
/// stable observation ids. Envelopes have their owner in api_test.dart.

Object jsonOf(Object raw) => raw is String ? jsonDecode(raw) : raw;

class FakeTransport {
  final responses = <String, Object>{};
  final statusOverrides = <String, int>{};
  final headerOverrides = <String, Map<String, String>>{};
  final errors = <String, Object>{};
  final requests =
      <({String method, String path, String? body, String? token})>[];
  final delays = <String, Duration>{};
  final deferred = <String, Completer<TransportResponse>>{};

  Transport build() => (method, path, {body, token}) async {
    final key = '$method $path';
    requests.add((method: method, path: path, body: body, token: token));
    final delay = delays[key];
    if (delay != null) await Future<void>.delayed(delay);
    final deferredCall = deferred[key];
    if (deferredCall != null) return deferredCall.future;
    final error = errors[key];
    if (error != null) throw error;
    final json = responses[key];
    if (json != null) {
      return TransportResponse(
        status: statusOverrides[key] ?? 200,
        json: jsonOf(json),
        headers: headerOverrides[key] ?? const {},
      );
    }
    return const TransportResponse(status: 200, json: {});
  };

  String previewBody({
    required String code,
    String state = 'claimable',
    String activityId = 'a1',
  }) =>
      '{"invite":{"code":"$code","rail":"public_share","generation":2,"state":"$state",'
      '"expiresAt":"2026-12-01T18:00:00Z","inviterDisplayName":"Inviter Name",'
      '"activity":{"id":"$activityId","title":"Evening walk","description":"Walk beside the river.","startsAt":"2026-12-01T18:00:00Z",'
      '"timezone":"Europe/Stockholm","priceMinorUnits":1200,"currency":"EUR","capacity":2,'
      '"bookedCount":1,"remainingSpots":1,"availabilityVersion":"4"},"plan":{"id":"p1","activityId":"$activityId","itinerary":"Meet at the bridge."},"host":{"id":"h1","displayName":"River Host","summary":"Local guide","previousActivities":[]}}}';

  String bookingBody({
    String userId = 'u1',
    String activityId = 'a1',
    String rail = 'public_share',
  }) =>
      '{"booking":{"id":"b1","activityId":"$activityId","planId":"p1","userId":"$userId",'
      '"createdAt":"2026-10-19T10:00:00Z","attribution":{"rail":"$rail","generation":2}}}';

  String claimBody({bool created = true, String userId = 'u1'}) =>
      '{"booking":{"id":"b1","activityId":"a1","planId":"p1","userId":"$userId",'
      '"createdAt":"2026-10-19T10:00:00Z","attribution":{"rail":"public_share","generation":2}},'
      '"created":$created,"attemptId":"at1","availabilityVersion":"5"}';

  String errorBody(String code) =>
      '{"error":{"code":"$code","message":"$code"}}';
}

class Harness {
  Harness() {
    directory = Directory.systemTemp.createTemp('velio-test-');
    transport = FakeTransport();
    controller = InviteController(
      api: VelioApi(baseUrl: 'http://test', transport: transport.build()),
      store: DeviceStore(directory: () => directory),
    );
  }
  late Future<Directory> directory;
  late FakeTransport transport;
  late InviteController controller;

  Future<StoredDevice> device() => controller.store.load();

  void addIdentity() {
    transport.responses['GET /my/bookings'] = {'bookings': []};
    transport.responses['GET /activities/a1/bookings/me'] = transport.errorBody(
      'booking_not_found',
    );
    transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    transport.responses['POST /demo/sessions'] = jsonOf({
      'session': {'token': 'tok-1', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {
        'id': 'u1',
        'email': 'guest@example.test',
        'displayName': 'Guest',
      },
      'created': true,
    });
  }

  Future<void> openAndSelect() async {
    addIdentity();
    transport.responses['GET /invites/2VKA1RPZ90S6'] = transport.previewBody(
      code: '2VKA1RPZ90S6',
    );
    await controller.openCode('2VKA1RPZ90S6');
    await controller.selectIdentity(
      email: 'guest@example.test',
      displayName: 'Guest',
    );
  }
}

void main() {
  test('a code opens the full preview before any identity selection', () async {
    final harness = Harness();
    harness.transport.responses['GET /invites/2VKA1RPZ90S6'] = harness.transport
        .previewBody(code: '2VKA1RPZ90S6');
    await harness.controller.openCode('2VKA1RPZ90S6');
    final preview = harness.controller.preview;
    expect(preview, isNotNull);
    expect(preview!.inviterDisplayName, 'Inviter Name');
    expect(preview.activity.title, 'Evening walk');
    expect(
      harness.controller.session,
      isNull,
      reason: 'preview needs no identity',
    );
  });

  test(
    'an unknown code preserves the entered code and Retry re-resolves it',
    () async {
      final harness = Harness();
      harness.transport.statusOverrides['GET /invites/BADCODE1'] = 404;
      harness.transport.responses['GET /invites/BADCODE1'] = harness.transport
          .errorBody('invite_not_found');
      await harness.controller.openCode('badcode1');
      expect(harness.controller.resolveError, isNotNull);
      expect(
        harness.controller.code,
        'BADCODE1',
        reason: 'code stays for retry',
      );
      harness.transport.statusOverrides.remove('GET /invites/BADCODE1');
      harness.transport.responses['GET /invites/BADCODE1'] = harness.transport
          .previewBody(code: 'BADCODE1');
      await harness.controller.openCode('badcode1');
      expect(harness.controller.preview, isNotNull);
    },
  );

  test('a late response for a replaced code never wins', () async {
    final harness = Harness();
    harness.transport.responses['GET /invites/CODEAAAA'] = harness.transport
        .previewBody(code: 'CODEAAAA', activityId: 'aaaa');
    harness.transport.delays['GET /invites/CODEBBBB'] = const Duration(
      milliseconds: 120,
    );
    harness.transport.responses['GET /invites/CODEBBBB'] = harness.transport
        .previewBody(code: 'CODEBBBB', activityId: 'bbbb');
    final slow = harness.controller.openCode('CODEAAAA');
    await harness.controller.openCode('CODEBBBB');
    await slow;
    expect(harness.controller.preview!.code, 'CODEBBBB');
  });

  test('a persisted account resumes and an expired credential restores the same email without losing the code', () async {
    final harness = Harness();
    harness.transport.responses['GET /invites/2VKA1RPZ90S6'] = harness.transport
        .previewBody(code: '2VKA1RPZ90S6');
    harness.addIdentity();
    await harness.controller.openCode('2VKA1RPZ90S6');
    await harness.controller.selectIdentity(
      email: 'guest@example.test',
      displayName: 'Guest',
    );
    expect(harness.controller.session!.token, 'tok-1');

    final resumed = InviteController(
      api: VelioApi(
        baseUrl: 'http://test',
        transport: harness.transport.build(),
      ),
      store: harness.controller.store,
    );
    harness.transport.responses['GET /demo/me'] = jsonOf({
      'user': {
        'id': 'u1',
        'email': 'guest@example.test',
        'displayName': 'Guest',
      },
    });
    await resumed.bootstrap();
    expect(resumed.session!.token, 'tok-1');
    expect(resumed.preview!.code, '2VKA1RPZ90S6');

    final invalid = InviteController(
      api: VelioApi(
        baseUrl: 'http://test',
        transport: harness.transport.build(),
      ),
      store: harness.controller.store,
    );
    harness.transport.statusOverrides['GET /demo/me'] = 401;
    harness.transport.responses['GET /demo/me'] = harness.transport.errorBody(
      'session_expired',
    );
    await invalid.bootstrap();
    expect(invalid.session!.email, 'guest@example.test');
    expect(invalid.code, '2VKA1RPZ90S6');
  });

  test('a claim persists the operation before the POST and keeps it stable across a lost response and retry', () async {
    final harness = Harness();
    await harness.openAndSelect();
    // First claim: response lost after the request may have committed.
    harness.transport.errors['POST /activities/a1/bookings'] =
        const SocketException('lost');
    harness.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    harness.transport.responses['GET /activities/a1/bookings/me'] = harness
        .transport
        .errorBody('booking_not_found');
    await harness.controller.claim();
    expect(
      harness.controller.claimState,
      isA<ClaimRefused>(),
      reason: 'contractual 404 -> definitively absent',
    );
    final posts = harness.transport.requests
        .where(
          (call) =>
              call.path == '/activities/a1/bookings' && call.method == 'POST',
        )
        .toList();
    expect(posts, hasLength(1));
    final firstOperationId =
        (jsonDecode(posts.first.body!) as Map)['operationId'] as String;

    // The stored operation was persisted before the POST and is reused.
    final stored = (await harness.device()).operations['u1:a1']!;
    expect(stored.operationId, firstOperationId);
    expect(stored.inviteCode, '2VKA1RPZ90S6');

    // Explicit retry sends the SAME operationId and the SAME bound code.
    harness.transport.errors.remove('POST /activities/a1/bookings');
    harness.transport.statusOverrides.remove('GET /activities/a1/bookings/me');
    harness.transport.responses['POST /activities/a1/bookings'] = harness
        .transport
        .claimBody(created: true);
    await harness.controller.claim();
    final retryPosts = harness.transport.requests
        .where(
          (call) =>
              call.path == '/activities/a1/bookings' && call.method == 'POST',
        )
        .toList();
    expect(retryPosts, hasLength(2));
    expect(
      (jsonDecode(retryPosts[1].body!) as Map)['operationId'],
      firstOperationId,
    );
    expect(
      (jsonDecode(retryPosts[1].body!) as Map)['inviteCode'],
      '2VKA1RPZ90S6',
    );
    expect(harness.controller.claimState, isA<ClaimConfirmed>());
  });

  test('a lost response confirmed by lookup shows the receipt, never invents created, and never re-haptics', () async {
    final harness = Harness();
    await harness.openAndSelect();
    harness.transport.statusOverrides['POST /activities/a1/bookings'] = 500;
    harness.transport.responses['POST /activities/a1/bookings'] = harness
        .transport
        .errorBody('booking_outcome_unknown');
    harness.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    harness.transport.responses['GET /activities/a1/bookings/me'] = harness
        .transport
        .errorBody('booking_not_found');
    await harness.controller.claim();
    expect(
      harness.controller.claimState,
      isA<ClaimRefused>().having((r) => r.reason, 'reason', 'absent'),
      reason: 'the contractual 404 establishes absence before any retry',
    );
    final postCountBefore = harness.transport.requests
        .where(
          (call) =>
              call.method == 'POST' && call.path == '/activities/a1/bookings',
        )
        .length;
    harness.transport.statusOverrides.remove('GET /activities/a1/bookings/me');
    harness.transport.responses['GET /activities/a1/bookings/me'] = harness
        .transport
        .bookingBody();
    await harness.controller.checkBooking();
    expect(
      harness.controller.claimState,
      isA<ClaimConfirmed>().having((c) => c.created, 'created', false),
    );
    final postCountAfter = harness.transport.requests
        .where(
          (call) =>
              call.method == 'POST' && call.path == '/activities/a1/bookings',
        )
        .length;
    expect(postCountAfter, postCountBefore);
    expect(harness.controller.consumeSuccessHaptic(), false);
  });

  test(
    'an unreachable lookup keeps uncertainty with an explicit check again',
    () async {
      final harness = Harness();
      await harness.openAndSelect();
      harness.transport.errors['POST /activities/a1/bookings'] =
          const SocketException('lost');
      harness.transport.errors['GET /activities/a1/bookings/me'] =
          const SocketException('down');
      await harness.controller.claim();
      expect(harness.controller.claimState, isA<ClaimUnknown>());
      harness.transport.errors.remove('GET /activities/a1/bookings/me');
      harness.transport.statusOverrides.remove(
        'GET /activities/a1/bookings/me',
      );
      harness.transport.responses['GET /activities/a1/bookings/me'] = harness
          .transport
          .bookingBody();
      await harness.controller.checkBooking();
      expect(harness.controller.claimState, isA<ClaimConfirmed>());
    },
  );

  test(
    'a double tap sends one POST and an in-flight claim blocks reentry',
    () async {
      final harness = Harness();
      await harness.openAndSelect();
      final pending = Completer<TransportResponse>();
      harness.transport.deferred['POST /activities/a1/bookings'] = pending;
      final first = harness.controller.claim();
      await harness.controller.claim();
      pending.complete(
        TransportResponse(
          status: 201,
          json: jsonOf(harness.transport.claimBody(created: true)),
        ),
      );
      await first;
      final posts = harness.transport.requests
          .where(
            (call) =>
                call.method == 'POST' && call.path == '/activities/a1/bookings',
          )
          .toList();
      expect(posts, hasLength(1));
    },
  );

  test('a 401 answer to a replaced-identity claim can never expire the new credential', () async {
    final harness = Harness();
    await harness.openAndSelect();
    final pending = Completer<TransportResponse>();
    harness.transport.deferred['POST /activities/a1/bookings'] = pending;
    final inFlight = harness.controller.claim();
    harness.transport.responses['POST /demo/sessions'] = jsonOf({
      'session': {'token': 'tok-2', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {
        'id': 'u2',
        'email': 'second@example.test',
        'displayName': 'Second',
      },
      'created': false,
    });
    await harness.controller.selectIdentity(
      email: 'second@example.test',
      displayName: 'Second',
    );
    expect(harness.controller.session!.token, 'tok-2');
    pending.complete(
      TransportResponse(
        status: 401,
        json: jsonOf(harness.transport.errorBody('session_expired')),
      ),
    );
    await inFlight;
    // The old credential's failure must not expire the new one.
    expect(harness.controller.session!.token, 'tok-2');
  });

  test('a rate-limited claim honors Retry-After and blocks an immediate second POST', () async {
    final harness = Harness();
    await harness.openAndSelect();
    harness.transport.responses['POST /activities/a1/bookings'] = harness
        .transport
        .errorBody('request_limit');
    harness.transport.statusOverrides['POST /activities/a1/bookings'] = 429;
    harness.transport.headerOverrides['POST /activities/a1/bookings'] = {
      'retry-after': '30',
    };
    await harness.controller.claim();
    final refused = harness.controller.claimState as ClaimRefused;
    expect(refused.retryAfterSeconds, 30);
    expect(refused.retryAt, isNotNull);
    await harness.controller.claim();
    final posts = harness.transport.requests
        .where(
          (call) =>
              call.method == 'POST' && call.path == '/activities/a1/bookings',
        )
        .toList();
    expect(
      posts,
      hasLength(1),
      reason: 'Retry-After blocks an immediate retry',
    );
  });

  test('a saved receipt wins over an expired invite, and a vouch mismatch never discloses the target', () async {
    final harness = Harness();
    harness.transport.responses['GET /invites/EXPRDCODE1'] = harness.transport
        .previewBody(code: 'EXPRDCODE1', state: 'expired');
    harness.addIdentity();
    await harness.controller.openCode('EXPRDCODE1');
    harness.transport.statusOverrides.remove('GET /activities/a1/bookings/me');
    harness.transport.responses['GET /activities/a1/bookings/me'] = harness
        .transport
        .bookingBody();
    await harness.controller.selectIdentity(
      email: 'guest@example.test',
      displayName: 'Guest',
    );
    expect(
      harness.controller.claimState,
      isA<ClaimConfirmed>(),
      reason: 'the saved receipt wins even though the invite is expired',
    );

    final mismatch = Harness();
    await mismatch.openAndSelect();
    mismatch.transport.statusOverrides['POST /activities/a1/bookings'] = 403;
    mismatch.transport.responses['POST /activities/a1/bookings'] = mismatch
        .transport
        .errorBody('invite_recipient_mismatch');
    await mismatch.controller.claim();
    final phase = mismatch.controller.claimState as ClaimRefused;
    expect(phase.reason, 'invite-mismatch');
    expect(phase.message.contains('another email'), true);
  });

  test('display telemetry emits activity_viewed and one stable invite_opened for documented states only', () async {
    final harness = Harness();
    harness.transport.responses['GET /invites/2VKA1RPZ90S6'] = harness.transport
        .previewBody(code: '2VKA1RPZ90S6');
    await harness.controller.openCode('2VKA1RPZ90S6');
    harness.controller.notePreviewDisplayed();
    harness.controller.notePreviewDisplayed();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final events = harness.transport.requests
        .where((call) => call.path == '/client-events' && call.method == 'POST')
        .map((call) => call.body!)
        .toList();
    expect(
      events.where((e) => e.contains('"type":"activity_viewed"')),
      hasLength(1),
    );
    final opened = events
        .where((e) => e.contains('"type":"invite_opened"'))
        .toList();
    expect(opened, hasLength(1));
    expect(opened.single.contains('"outcome":"available"'), true);
    expect(opened.single.contains('"channel":"flutter"'), true);

    final second = Harness();
    second.transport.responses['GET /invites/STARTEDC1'] = second.transport
        .previewBody(code: 'STARTEDC1', state: 'expired');
    await second.controller.openCode('STARTEDC1');
    second.controller.notePreviewDisplayed();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final startedEvents = second.transport.requests
        .where((call) => call.path == '/client-events')
        .map((call) => call.body!)
        .toList();
    expect(
      startedEvents.any((e) => e.contains('"type":"activity_viewed"')),
      true,
    );
    expect(
      startedEvents.any(
        (e) =>
            e.contains('"type":"invite_opened"') &&
            e.contains('"outcome":"expired"'),
      ),
      true,
    );
  });

  test('only a newly committed confirmation pends the success haptic', () async {
    final harness = Harness();
    await harness.openAndSelect();
    harness.transport.responses['POST /activities/a1/bookings'] = harness
        .transport
        .claimBody(created: false);
    await harness.controller.claim();
    expect(harness.controller.claimState, isA<ClaimConfirmed>());
    expect(
      harness.controller.consumeSuccessHaptic(),
      false,
      reason:
          'a replayed booking is the recovered record, not a new confirmation',
    );
  });
}
