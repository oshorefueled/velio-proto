import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/invite_screen.dart';

/// Rendered invite screen checks (issue #19): the displayed preview before
/// any identity, unusable-state explanations without claim controls, receipt
/// precedence, and exactly one platform-channel success haptic at the first
/// displayed confirmation. Arbitration has its owner in the controller suite.
Object jsonOf(Object raw) => raw is String ? jsonDecode(raw) : raw;

class FakeTransport {
  final responses = <String, Object>{};
  final statusOverrides = <String, int>{};

  Transport build() => (method, path, {body, token}) async {
    final key = '$method $path';
    final json = responses[key];
    if (json != null) {
      return TransportResponse(
        status: statusOverrides[key] ?? 200,
        json: jsonOf(json),
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

  String claimBody({bool created = true}) =>
      '{"booking":{"id":"b1","activityId":"a1","planId":"p1","userId":"u1",'
      '"createdAt":"2026-10-19T10:00:00Z","attribution":{"rail":"public_share","generation":2}},'
      '"created":$created,"attemptId":"at1","availabilityVersion":"5"}';

  String errorBody(String code) =>
      '{"error":{"code":"$code","message":"$code"}}';
}

Future<InviteController> mountedController(
  WidgetTester tester, {
  required FakeTransport transport,
}) async {
  final controller = InviteController(
    api: VelioApi(baseUrl: 'http://test', transport: transport.build()),
    store: DeviceStore.inMemory(),
  );
  await tester.pumpWidget(
    MaterialApp(home: InviteScreen(controller: controller)),
  );
  await tester.pump();
  return controller;
}

void main() {
  setUpAll(tzdata.initializeTimeZones);

  for (final sample in [
    (currency: 'JPY', minorUnits: 1200, expected: '¥1,200'),
    (currency: 'KWD', minorUnits: 1234, expected: '1.234'),
  ]) {
    testWidgets(
      'when a ${sample.currency} invitation renders, price uses that currency’s minor units',
      (tester) async {
        final transport = FakeTransport();
        final json =
            jsonDecode(transport.previewBody(code: 'M0NEYC0DE1')) as Map;
        json['invite']['activity']['currency'] = sample.currency;
        json['invite']['activity']['priceMinorUnits'] = sample.minorUnits;
        transport.responses['GET /invites/M0NEYC0DE1'] = json;
        final controller = await mountedController(
          tester,
          transport: transport,
        );
        await controller.openCode('M0NEYC0DE1');
        await tester.pumpAndSettle();
        expect(find.textContaining(sample.expected), findsOneWidget);
      },
    );
  }

  testWidgets(
    'when a used invitation opens, signed-out guests see the plan and host and one used observation after display',
    (tester) async {
      final events = <Map>[];
      final fixture = FakeTransport();
      final json = jsonDecode(
        fixture.previewBody(code: 'USEDCODE1', state: 'used'),
      ) as Map;
      json['invite']['activity']['description'] = 'Walk beside the river.';
      json['invite']['plan'] = {
        'id': 'p1',
        'activityId': 'a1',
        'itinerary': 'Meet at the bridge.',
      };
      json['invite']['host'] = {
        'id': 'h1',
        'displayName': 'River Host',
        'summary': 'Local walking guide',
        'previousActivities': [],
      };
      final controller = InviteController(
        api: VelioApi(
          baseUrl: 'http://test',
          transport: (method, path, {body, token}) async {
            if (path == '/invites/USEDCODE1') {
              return TransportResponse(status: 200, json: json);
            }
            if (path == '/client-events') events.add(jsonDecode(body!) as Map);
            return const TransportResponse(status: 200, json: {});
          },
        ),
        store: DeviceStore.inMemory(),
      );
      await tester.pumpWidget(
        MaterialApp(home: InviteScreen(controller: controller)),
      );
      await controller.openCode('USEDCODE1');
      expect(events, isEmpty);
      await tester.pumpAndSettle();
      expect(controller.session, isNull);
      expect(find.text('Walk beside the river.'), findsOneWidget);
      expect(find.text('Meet at the bridge.'), findsOneWidget);
      expect(find.textContaining('River Host'), findsOneWidget);
      expect(find.textContaining('already been used'), findsOneWidget);
      expect(
        events
            .where((event) => event['type'] == 'invite_opened')
            .map((event) => event['outcome']),
        ['used'],
      );
      await tester.pump();
      expect(
        events.where((event) => event['type'] == 'invite_opened'),
        hasLength(1),
      );
    },
  );

  testWidgets(
    'a code displays inviter, rail, schedule in the activity timezone, price, expiry and availability before identity',
    (tester) async {
      final transport = FakeTransport();
      transport.responses['GET /invites/2VKA1RPZ90S6'] = transport.previewBody(
        code: '2VKA1RPZ90S6',
      );
      final controller = await mountedController(tester, transport: transport);
      await tester.enterText(
        find.byKey(const Key('code-field')),
        '2VKA1RPZ90S6',
      );
      await tester.tap(find.byKey(const Key('open-code')));
      await tester.pumpAndSettle();
      final body = find.byKey(const Key('preview-card'));
      expect(body, findsOneWidget);
      final text = tester
          .widget<Text>(
            find.descendant(of: body, matching: find.byType(Text)).first,
          )
          .data;
      expect(text, 'Evening walk');
      expect(find.textContaining('Invited by Inviter Name'), findsOneWidget);
      expect(
        find.textContaining('Europe/Stockholm'),
        findsWidgets,
        reason: 'schedule shows the activity timezone, not the device zone',
      );
      expect(find.textContaining('€12.00'), findsOneWidget);
      expect(find.textContaining('Invitation expires'), findsOneWidget);
      expect(find.byKey(const Key('availability')), findsOneWidget);
      expect(
        controller.session,
        isNull,
        reason: 'facts render before identity',
      );
    },
  );

  testWidgets(
    'an unusable invitation shows its explanation without claim controls',
    (tester) async {
      final transport = FakeTransport();
      transport.responses['GET /invites/FULLCODE1'] = transport.previewBody(
        code: 'FULLCODE1',
        state: 'full',
      );
      await mountedController(tester, transport: transport);
      await tester.enterText(find.byKey(const Key('code-field')), 'FULLCODE1');
      await tester.tap(find.byKey(const Key('open-code')));
      await tester.pumpAndSettle();
      expect(find.textContaining('The activity is full'), findsOneWidget);
      expect(find.byKey(const Key('claim')), findsNothing);
      expect(
        find.byKey(const Key('claim-card')),
        findsNothing,
        reason: 'no session means no claim controls at all',
      );
    },
  );

  testWidgets(
    'exactly one medium-impact haptic fires through the platform channel at the first displayed confirmation',
    (tester) async {
      final haptics = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method.startsWith('HapticFeedback.')) {
            haptics.add(call.method);
          }
          return null;
        },
      );
      final transport = FakeTransport();
      transport.responses['GET /invites/2VKA1RPZ90S6'] = transport.previewBody(
        code: '2VKA1RPZ90S6',
      );
      transport.responses['POST /demo/sessions'] = jsonOf({
        'session': {'token': 'tok-1', 'expiresAt': '2027-01-01T00:00:00Z'},
        'user': {'id': 'u1', 'contactKey': 'guest', 'displayName': 'Guest'},
        'created': true,
      });
      transport.responses['POST /activities/a1/bookings'] = transport.claimBody(
        created: true,
      );
      transport.statusOverrides['GET /activities/a1/bookings/me'] = 404;
      transport.responses['GET /activities/a1/bookings/me'] = transport
          .errorBody('booking_not_found');
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await mountedController(tester, transport: transport);
      await tester.enterText(
        find.byKey(const Key('code-field')),
        '2VKA1RPZ90S6',
      );
      await tester.tap(find.byKey(const Key('open-code')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('contact-field')), 'guest');
      await tester.tap(find.byKey(const Key('select-identity')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('claim')));
      await tester.pumpAndSettle();
      expect(find.textContaining('Your spot is saved'), findsOneWidget);
      // Extra frames (rebuilds) must never repeat the haptic.
      await tester.pump();
      await tester.pump();
      expect(haptics, hasLength(1));
      // Extra frames (rebuilds) must never repeat the haptic.
      await tester.pump();
      await tester.pump();
      expect(haptics, hasLength(1));
    },
  );
}
