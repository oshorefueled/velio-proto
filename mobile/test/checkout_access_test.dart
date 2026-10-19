import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_links.dart';

import 'invite_controller_test.dart' show Harness;

void main() {
  test('a C1 email-only user decodes without a legacy contact key', () async {
    final api = VelioApi(
      baseUrl: 'http://test',
      transport: (method, path, {body, token}) async => const TransportResponse(
        status: 200,
        json: {
          'user': {
            'id': 'u1',
            'email': 'guest@example.test',
            'displayName': 'Guest',
            'signupSource': 'direct',
            'signupGeneration': 0,
          },
        },
      ),
    );
    expect((await api.me('tok')).email, 'guest@example.test');
  });

  test('signed-out checkout continuation records visit context without creating an account or booking', () async {
    final h = Harness();
    h.transport.responses['GET /invites/CODEAAAA'] = h.transport.previewBody(
      code: 'CODEAAAA',
    );
    await h.controller.openLink(
      const InviteLink('CODEAAAA', visitorId: 'visitor', visitId: 'visit'),
    );
    h.controller.continueToCheckout();
    await Future<void>.delayed(Duration.zero);
    final events = h.transport.requests
        .where((r) => r.path == '/client-events')
        .map((r) => jsonDecode(r.body!) as Map);
    expect(events.single, containsPair('type', 'claim_started'));
    expect(events.single, containsPair('visitId', 'visit'));
    expect(events.single, containsPair('visitorId', 'visitor'));
    expect(
      h.transport.requests.where(
        (r) => r.path == '/demo/sessions' || r.path.contains('/bookings'),
      ),
      isEmpty,
    );
  });

  test('an expired persisted credential restores the remembered email after restart without replaying a claim', () async {
    final h = Harness();
    await h.openAndSelect();
    final directory = await h.directory;
    h.transport.responses['GET /demo/me'] = h.transport.errorBody(
      'session_expired',
    );
    h.transport.statusOverrides['GET /demo/me'] = 401;
    h.transport.responses['POST /demo/sessions'] = {
      'session': {'token': 'restored', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {
        'id': 'u1',
        'email': 'guest@example.test',
        'displayName': 'Guest',
      },
      'created': false,
    };
    h.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    h.transport.responses['GET /activities/a1/bookings/me'] = h.transport
        .errorBody('booking_not_found');
    final resumed = InviteController(
      api: h.controller.api,
      store: DeviceStore(directory: () async => directory),
    );
    h.transport.requests.clear();
    await resumed.bootstrap();
    expect(resumed.session!.token, 'restored');
    expect(resumed.session!.email, 'guest@example.test');
    expect(resumed.code, '2VKA1RPZ90S6');
    final body = jsonDecode(
      h.transport.requests.singleWhere((r) => r.path == '/demo/sessions').body!,
    ) as Map;
    expect(body['email'], 'guest@example.test');
    expect(body.containsKey('inviteCode'), false);
    expect(
      h.transport.requests.where(
        (r) => r.method == 'POST' && r.path.endsWith('/bookings'),
      ),
      isEmpty,
    );
  });

  test(
    'a restoration outage preserves the remembered account and invitation',
    () async {
      final h = Harness();
      await h.openAndSelect();
      h.transport.errors['GET /demo/me'] = const SocketException('offline');
      final resumed = InviteController(
        api: h.controller.api,
        store: h.controller.store,
      );
      await resumed.bootstrap();
      expect(resumed.session!.userId, 'u1');
      expect(resumed.session!.email, 'guest@example.test');
      expect(resumed.code, '2VKA1RPZ90S6');
    },
  );

  test('a late bootstrap 401 cannot replace an account selected while validation was pending', () async {
    final h = Harness();
    await h.openAndSelect();
    final pending = Completer<TransportResponse>();
    h.transport.deferred['GET /demo/me'] = pending;
    final resumed = InviteController(
      api: h.controller.api,
      store: h.controller.store,
    );
    final boot = resumed.bootstrap();
    await Future<void>.delayed(Duration.zero);
    h.transport.responses['POST /demo/sessions'] = {
      'session': {'token': 'tok-2', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {
        'id': 'u2',
        'email': 'second@example.test',
        'displayName': 'Second',
      },
      'created': false,
    };
    await resumed.selectIdentity(
      email: 'second@example.test',
      independent: true,
    );
    pending.complete(
      TransportResponse(
        status: 401,
        json: jsonDecode(h.transport.errorBody('session_expired')),
      ),
    );
    await boot;
    expect(resumed.session!.userId, 'u2');
    expect(resumed.session!.token, 'tok-2');
  });

  test('verified absence refreshes the originally bound invitation and prevents a retry when it fills', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.errors['POST /activities/a1/bookings'] = const SocketException(
      'lost',
    );
    h.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
    h.transport.responses['GET /activities/a1/bookings/me'] = h.transport
        .errorBody('booking_not_found');
    h.transport.responses['GET /invites/2VKA1RPZ90S6'] = h.transport
        .previewBody(code: '2VKA1RPZ90S6', state: 'full');
    await h.controller.claim();
    final count = h.transport.requests
        .where((r) => r.path == '/invites/2VKA1RPZ90S6')
        .length;
    expect(count, greaterThan(1));
    await h.controller.claim();
    expect(
      h.transport.requests.where(
        (r) => r.method == 'POST' && r.path.endsWith('/bookings'),
      ),
      hasLength(1),
    );
  });

  test(
    'unknown booking lookup cannot be bypassed by calling claim again',
    () async {
      final h = Harness();
      await h.openAndSelect();
      h.transport.errors['POST /activities/a1/bookings'] =
          const SocketException('lost');
      h.transport.errors['GET /activities/a1/bookings/me'] =
          const SocketException('offline');
      await h.controller.claim();
      await h.controller.claim();
      expect(
        h.transport.requests.where(
          (r) => r.method == 'POST' && r.path.endsWith('/bookings'),
        ),
        hasLength(1),
      );
    },
  );

  test('independent sign in loads summary bookings and sign out discards late list responses', () async {
    final h = Harness();
    h.addIdentity();
    h.transport.responses['GET /my/bookings'] = {
      'bookings': [
        {
          'id': 'b1',
          'activityId': 'a1',
          'planId': 'p1',
          'activity': {
            'id': 'a1',
            'title': 'Evening walk',
            'startsAt': '2026-12-01T18:00:00Z',
            'timezone': 'Europe/Stockholm',
          },
        },
      ],
    };
    await h.controller.selectIdentity(
      email: 'guest@example.test',
      independent: true,
    );
    expect(h.controller.savedBookings.single.title, 'Evening walk');
    expect(h.controller.code, isNull);
    final pending = Completer<TransportResponse>();
    h.transport.deferred['GET /my/bookings'] = pending;
    final loading = h.controller.loadSavedBookings();
    h.controller.signOut();
    pending.complete(
      const TransportResponse(status: 200, json: {'bookings': []}),
    );
    await loading;
    expect(h.controller.session, isNull);
    expect(h.controller.savedBookings, isEmpty);
  });
  test('Retry-After expires from the response time rather than extending on each check', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .errorBody('request_limit');
    h.transport.statusOverrides['POST /activities/a1/bookings'] = 429;
    h.transport.headerOverrides['POST /activities/a1/bookings'] = {
      'retry-after': '1',
    };
    await h.controller.claim();
    final refused = h.controller.claimState as ClaimRefused;
    final deadline = refused.retryAt!;
    await Future<void>.delayed(const Duration(milliseconds: 1050));
    expect(refused.retryAt, deadline);
    expect(refused.retryAt!.isAfter(DateTime.now()), false);
  });

  for (final valid in [true, false]) {
    test(
      'a legacy device file with ${valid ? "valid" : "expired"} access preserves invitation and operations while ${valid ? "learning email" : "requiring Sign in"}',
      () async {
        final h = Harness();
        final dir = await h.directory;
        final visitor = generateUuidV4();
        final operation = generateUuidV4();
        await File('${dir.path}/velio-device.json').writeAsString(
          jsonEncode({
            'visitorId': visitor,
            'session': {
              'token': 'old-token',
              'userId': 'u1',
              'displayName': 'Guest',
            },
            'lastCode': 'CODEAAAA',
            'operations': {
              'u1:a1': {'operationId': operation, 'inviteCode': 'CODEAAAA'},
            },
          }),
        );
        h.transport.responses['GET /demo/me'] = valid
            ? {
                'user': {
                  'id': 'u1',
                  'email': 'guest@example.test',
                  'displayName': 'Guest',
                },
              }
            : jsonDecode(h.transport.errorBody('session_expired'));
        h.transport.statusOverrides['GET /demo/me'] = valid ? 200 : 401;
        h.transport.responses['GET /invites/CODEAAAA'] = h.transport
            .previewBody(code: 'CODEAAAA');
        h.transport.responses['GET /activities/a1/bookings/me'] = jsonDecode(
          h.transport.errorBody('booking_not_found'),
        );
        h.transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
        h.transport.responses['GET /my/bookings'] = {'bookings': []};
        await h.controller.bootstrap();
        final persisted = await DeviceStore(directory: () async => dir).load();
        expect(persisted.visitorId, visitor);
        expect(persisted.lastCode, 'CODEAAAA');
        expect(persisted.operations['u1:a1']!.operationId, operation);
        expect(persisted.session?.email, valid ? 'guest@example.test' : isNull);
        expect(h.transport.requests.where((r) => r.method == 'POST'), isEmpty);
        if (!valid) expect(h.controller.identityError, contains('Sign in'));
      },
    );
  }

  test('bootstrap validation completing after checkout opens cannot reset the current invitation or checkout', () async {
    final h = Harness();
    await h.openAndSelect();
    final pending = Completer<TransportResponse>();
    h.transport.deferred['GET /demo/me'] = pending;
    final resumed = InviteController(
      api: h.controller.api,
      store: h.controller.store,
    );
    final boot = resumed.bootstrap();
    await Future<void>.delayed(Duration.zero);
    h.transport.responses['GET /invites/CODEBBBB'] = h.transport.previewBody(
      code: 'CODEBBBB',
    );
    await resumed.openCode('CODEBBBB');
    resumed.continueToCheckout();
    pending.complete(
      const TransportResponse(
        status: 200,
        json: {
          'user': {
            'id': 'u1',
            'email': 'guest@example.test',
            'displayName': 'Guest',
          },
        },
      ),
    );
    await boot;
    expect(resumed.code, 'CODEBBBB');
    expect(resumed.checkout, true);
  });

  test('a pending account entry cannot overwrite the account selected after Sign out', () async {
    final h = Harness();
    h.addIdentity();
    final pending = Completer<TransportResponse>();
    h.transport.deferred['POST /demo/sessions'] = pending;
    final oldEntry = h.controller.selectIdentity(
      email: 'old@example.test',
      independent: true,
    );
    await Future<void>.delayed(Duration.zero);
    h.controller.signOut();
    h.transport.deferred.remove('POST /demo/sessions');
    h.transport.responses['POST /demo/sessions'] = {
      'session': {'token': 'tok-2', 'expiresAt': '2027-01-01T00:00:00Z'},
      'user': {'id': 'u2', 'email': 'new@example.test', 'displayName': 'New'},
      'created': false,
    };
    await h.controller.selectIdentity(
      email: 'new@example.test',
      independent: true,
    );
    pending.complete(
      const TransportResponse(
        status: 200,
        json: {
          'session': {'token': 'tok-old', 'expiresAt': '2027-01-01T00:00:00Z'},
          'user': {
            'id': 'u1',
            'email': 'old@example.test',
            'displayName': 'Old',
          },
          'created': false,
        },
      ),
    );
    await oldEntry;
    expect(h.controller.session!.userId, 'u2');
    final persisted = await DeviceStore(directory: () => h.directory).load();
    expect(persisted.session!.userId, 'u2');
  });
  test('a sold-out confirmation refreshes availability and retains the reviewed invitation', () async {
    final h = Harness();
    await h.openAndSelect();
    final full = jsonDecode(
      h.transport.previewBody(code: '2VKA1RPZ90S6', state: 'full'),
    ) as Map;
    full['invite']['activity']['remainingSpots'] = 0;
    full['invite']['activity']['bookedCount'] = 2;
    h.transport.responses['GET /invites/2VKA1RPZ90S6'] = full;
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .errorBody('activity_sold_out');
    h.transport.statusOverrides['POST /activities/a1/bookings'] = 409;
    await h.controller.claim();
    expect((h.controller.claimState as ClaimRefused).reason, 'sold-out');
    expect(h.controller.preview!.activity.remainingSpots, 0);
    expect(h.controller.code, '2VKA1RPZ90S6');
  });
  test('an uncertain claim survives a fresh device store and a different code with its original operation and invitation', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.errors['POST /activities/a1/bookings'] = const SocketException(
      'lost',
    );
    h.transport.errors['GET /activities/a1/bookings/me'] =
        const SocketException('offline');
    await h.controller.claim();
    final original = (await h.device()).operations['u1:a1']!;
    h.transport.errors.clear();
    h.transport.responses['GET /demo/me'] = {
      'user': {
        'id': 'u1',
        'email': 'guest@example.test',
        'displayName': 'Guest',
      },
    };
    h.transport.responses['GET /invites/CODEBBBB'] = h.transport.previewBody(
      code: 'CODEBBBB',
    );
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .claimBody();
    final resumed = InviteController(
      api: h.controller.api,
      store: DeviceStore(directory: () => h.directory),
    );
    await resumed.bootstrap();
    await resumed.openCode('CODEBBBB');
    expect(
      h.transport.requests.where(
        (r) => r.method == 'POST' && r.path.endsWith('/bookings'),
      ),
      hasLength(1),
    );
    resumed.continueToCheckout();
    await resumed.claim();
    final posts = h.transport.requests
        .where((r) => r.method == 'POST' && r.path.endsWith('/bookings'))
        .toList();
    expect(posts, hasLength(2));
    expect(jsonDecode(posts.last.body!)['operationId'], original.operationId);
    expect(jsonDecode(posts.last.body!)['inviteCode'], '2VKA1RPZ90S6');
    expect(resumed.claimState, isA<ClaimConfirmed>());
  });

  test('changing invitations during account entry discards the old account callback', () async {
    final h = Harness();
    h.addIdentity();
    h.transport.responses['GET /invites/CODEAAAA'] = h.transport.previewBody(
      code: 'CODEAAAA',
    );
    h.transport.responses['GET /invites/CODEBBBB'] = h.transport.previewBody(
      code: 'CODEBBBB',
    );
    await h.controller.openCode('CODEAAAA');
    final pending = Completer<TransportResponse>();
    h.transport.deferred['POST /demo/sessions'] = pending;
    final entry = h.controller.selectIdentity(email: 'guest@example.test');
    await Future<void>.delayed(Duration.zero);
    await h.controller.openCode('CODEBBBB');
    pending.complete(
      const TransportResponse(
        status: 200,
        json: {
          'session': {'token': 'old', 'expiresAt': '2027-01-01T00:00:00Z'},
          'user': {
            'id': 'u1',
            'email': 'guest@example.test',
            'displayName': 'Guest',
          },
          'created': false,
        },
      ),
    );
    await entry;
    expect(h.controller.code, 'CODEBBBB');
    expect(h.controller.session, isNull);
    expect(h.controller.identityBusy, false);
  });

  test('a definitive recipient refusal allows the same account to confirm through a different invitation', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .errorBody('invite_recipient_mismatch');
    h.transport.statusOverrides['POST /activities/a1/bookings'] = 403;
    await h.controller.claim();
    final refusedId = (await h.device()).operations['u1:a1']!.operationId;
    h.transport.responses['GET /invites/CODEBBBB'] = h.transport.previewBody(
      code: 'CODEBBBB',
    );
    await h.controller.openCode('CODEBBBB');
    h.transport.statusOverrides['POST /activities/a1/bookings'] = 201;
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .claimBody();
    await h.controller.claim();
    final posts = h.transport.requests
        .where((r) => r.method == 'POST' && r.path.endsWith('/bookings'))
        .toList();
    expect(posts, hasLength(2));
    expect(jsonDecode(posts.last.body!)['inviteCode'], 'CODEBBBB');
    expect(jsonDecode(posts.last.body!)['operationId'], isNot(refusedId));
  });

  test('absence after a lost response says a repeat returns the same booking rather than that none exists', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.errors['POST /activities/a1/bookings'] = const SocketException(
      'lost',
    );
    await h.controller.claim();
    final refused = h.controller.claimState as ClaimRefused;
    expect(refused.reason, 'absent');
    expect(refused.message, contains('same booking'));
  });

  test('an unreachable booking check explains the connection without raw exception text', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.errors['POST /activities/a1/bookings'] = const SocketException(
      'lost',
    );
    h.transport.errors['GET /activities/a1/bookings/me'] =
        const SocketException('Connection failed (OS Error: errno = 101)');
    await h.controller.claim();
    final unknown = h.controller.claimState as ClaimUnknown;
    expect(unknown.message, isNot(contains('SocketException')));
    expect(unknown.message, isNot(contains('errno')));
  });

  test('a booking recovered after a lost response appears in the saved list', () async {
    final h = Harness();
    await h.openAndSelect();
    expect(h.controller.savedBookings, isEmpty);
    h.transport.errors['POST /activities/a1/bookings'] = const SocketException(
      'lost',
    );
    h.transport.statusOverrides.remove('GET /activities/a1/bookings/me');
    h.transport.responses['GET /activities/a1/bookings/me'] = h.transport
        .bookingBody();
    h.transport.responses['GET /my/bookings'] = {
      'bookings': [
        {
          'id': 'b1',
          'activityId': 'a1',
          'planId': 'p1',
          'activity': {
            'id': 'a1',
            'title': 'Evening walk',
            'startsAt': '2026-12-01T18:00:00Z',
            'timezone': 'Europe/Stockholm',
          },
        },
      ],
    };
    await h.controller.claim();
    expect(h.controller.claimState, isA<ClaimConfirmed>());
    await Future<void>.delayed(Duration.zero);
    expect(h.controller.savedBookings.single.title, 'Evening walk');
  });

  test('an invitation that expires during checkout refreshes the preview to expired', () async {
    final h = Harness();
    await h.openAndSelect();
    h.transport.responses['GET /invites/2VKA1RPZ90S6'] = h.transport
        .previewBody(code: '2VKA1RPZ90S6', state: 'expired');
    h.transport.responses['POST /activities/a1/bookings'] = h.transport
        .errorBody('invite_expired');
    h.transport.statusOverrides['POST /activities/a1/bookings'] = 410;
    await h.controller.claim();
    expect((h.controller.claimState as ClaimRefused).reason, 'invite-expired');
    expect(h.controller.preview!.state, 'expired');
  });
}
