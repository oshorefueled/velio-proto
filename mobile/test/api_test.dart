import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';

/// Wire boundary checks (issue #19): literal documented envelopes, machine
/// error codes, Retry-After plumbing, and exact request bodies. Arbitration
/// and rendering have their canonical owners in the controller/screen suites.
Transport ok(
  Object json, {
  int status = 200,
  Map<String, String> headers = const {},
}) =>
    (methodArg, pathArg, {body, token}) async =>
        TransportResponse(status: status, json: json, headers: headers);

void main() {
  test('resolveInvite parses the literal public invite envelope without exposing a target contact', () async {
    final api = VelioApi(
      baseUrl: 'http://localhost:3000',
      transport: ok({
        'invite': {
          'code': '2VKA1RPZ90S6',
          'rail': 'public_share',
          'generation': 2,
          'state': 'claimable',
          'expiresAt': '2026-12-01T18:00:00Z',
          'inviterDisplayName': 'Inviter Name',
          'plan': {
            'id': 'p1',
            'activityId': 'a1',
            'itinerary': 'Meet at the bridge.',
          },
          'host': {
            'id': 'h1',
            'displayName': 'River Host',
            'summary': '',
            'previousActivities': [],
          },
          'targetContactKey': 'secret-contact-never-exposed',
          'activity': {
            'id': 'a1',
            'title': 'Evening walk',
            'description': 'Walk beside the river.',
            'startsAt': '2026-12-01T18:00:00Z',
            'timezone': 'Europe/Stockholm',
            'priceMinorUnits': 1200,
            'currency': 'EUR',
            'capacity': 2,
            'bookedCount': 1,
            'remainingSpots': 1,
            'availabilityVersion': '4',
          },
        },
      }),
    );
    final preview = await api.resolveInvite('2VKA1RPZ90S6');
    expect(preview.code, '2VKA1RPZ90S6');
    expect(preview.rail, 'public_share');
    expect(preview.state, 'claimable');
    expect(preview.inviterDisplayName, 'Inviter Name');
    expect(preview.activity.title, 'Evening walk');
    expect(preview.activity.timezone, 'Europe/Stockholm');
    expect(preview.activity.priceMinorUnits, 1200);
    expect(preview.activity.remainingSpots, 1);
  });

  test('machine error envelopes become ApiError with the documented code and Retry-After', () async {
    final api = VelioApi(
      baseUrl: 'http://x',
      transport: ok(
        {
          'error': {'code': 'request_limit', 'message': 'Too many'},
        },
        status: 429,
        headers: {'retry-after': '7'},
      ),
    );
    await expectLater(
      api.resolveInvite('BAD'),
      throwsA(
        isA<ApiError>()
            .having((e) => e.status, 'status', 429)
            .having((e) => e.code, 'code', 'request_limit')
            .having((e) => e.retryAfterSeconds, 'retryAfter', 7),
      ),
    );
  });

  test('a status failure without an error envelope is a server_error, and 404 booking_not_found is preserved', () async {
    final api = VelioApi(
      baseUrl: 'http://x',
      transport: ok({'unexpected': true}, status: 500),
    );
    await expectLater(
      api.getMyBooking('t', 'a1'),
      throwsA(isA<ApiError>().having((e) => e.code, 'code', 'server_error')),
    );
    final absent = VelioApi(
      baseUrl: 'http://x',
      transport: ok({
        'error': {'code': 'booking_not_found', 'message': 'none'},
      }, status: 404),
    );
    await expectLater(
      absent.getMyBooking('t', 'a1'),
      throwsA(
        isA<ApiError>()
            .having((e) => e.status, 'status', 404)
            .having((e) => e.code, 'code', 'booking_not_found'),
      ),
    );
  });

  test('claim posts the exact documented body with operationId and the bound invite code', () async {
    final bodies = <String>[];
    final api = VelioApi(
      baseUrl: 'http://x',
      transport: (method, path, {body, token}) async {
        bodies.add(body ?? '');
        return TransportResponse(
          status: 201,
          json: {
            'booking': {
              'id': 'b1',
              'activityId': 'a1',
              'planId': 'p1',
              'userId': 'u1',
              'createdAt': '2026-10-19T10:00:00Z',
              'attribution': {'rail': 'public_share', 'generation': 2},
            },
            'created': true,
            'attemptId': 'at1',
            'availabilityVersion': '5',
          },
        );
      },
    );
    final result = await api.bookActivity(
      'token',
      'a1',
      'op-1',
      inviteCode: '2VKA1RPZ90S6',
    );
    expect(result.created, true);
    expect(result.booking.rail, 'public_share');
    final body = bodies.single;
    expect(body.contains('"operationId":"op-1"'), true);
    expect(body.contains('"inviteCode":"2VKA1RPZ90S6"'), true);
  });

  test('establishment carries visitorId, channel flutter and the invite code; me validates the credential', () async {
    final calls =
        <({String method, String path, String? body, String? token})>[];
    final api = VelioApi(
      baseUrl: 'http://x',
      transport: (method, path, {body, token}) async {
        calls.add((method: method, path: path, body: body, token: token));
        if (path == '/demo/sessions') {
          return TransportResponse(
            status: 200,
            json: {
              'session': {'token': 'tok', 'expiresAt': '2027-01-01T00:00:00Z'},
              'user': {
                'id': 'u1',
                'email': 'guest@example.test',
                'displayName': 'Guest',
                'signupSource': 'public_share',
                'signupGeneration': 2,
              },
              'created': true,
            },
          );
        }
        return TransportResponse(
          status: 200,
          json: {
            'user': {
              'id': 'u1',
              'email': 'guest@example.test',
              'displayName': 'Guest',
            },
          },
        );
      },
    );
    final establishment = await api.establishSession(
      email: 'guest@example.test',
      displayName: 'Guest',
      inviteCode: '2VKA1RPZ90S6',
      visitorId: 'vis-1',
    );
    expect(establishment.created, true);
    expect(establishment.token, 'tok');
    final sessionCall = calls.first;
    expect(sessionCall.body!.contains('"visitorId":"vis-1"'), true);
    expect(sessionCall.body!.contains('"channel":"flutter"'), true);
    expect(sessionCall.body!.contains('"inviteCode":"2VKA1RPZ90S6"'), true);
    final meCall = await api.me('tok');
    expect(meCall.id, 'u1');
    expect(calls.last.token, 'tok');
  });
}
