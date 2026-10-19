import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_links.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('initial and warm supported links and manual code resolve through one signed-out preview owner, retaining only supplied visit references', () async {
    const visitor = '11111111-1111-4111-8111-111111111111';
    const visit = '22222222-2222-4222-8222-222222222222';
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      const MethodChannel('com.llfbandit.app_links/messages'),
      (call) async =>
          'velio://invite/CODEAAAA?visitorId=$visitor&visitId=$visit',
    );
    messenger.setMockMethodCallHandler(
      const MethodChannel('com.llfbandit.app_links/events'),
      (call) async => null,
    );
    final requests = <String>[];
    final events = <Map>[];
    final store = DeviceStore.inMemory();
    final controller = InviteController(
      api: VelioApi(
        baseUrl: 'http://test',
        transport: (method, path, {body, token}) async {
          requests.add('$method $path');
          if (path == '/client-events') {
            events.add(jsonDecode(body!) as Map);
            return const TransportResponse(status: 200, json: {});
          }
          final code = path.split('/').last;
          return TransportResponse(
            status: 200,
            json: {
              'invite': {
                'code': code,
                'rail': 'public_share',
                'generation': 1,
                'state': 'claimable',
                'expiresAt': '2027-01-01T00:00:00Z',
                'inviterDisplayName': 'Inviter',
                'activity': {
                  'id': 'a',
                  'title': 'Walk',
                  'description': 'A river walk',
                  'startsAt': '2027-01-01T00:00:00Z',
                  'timezone': 'UTC',
                  'priceMinorUnits': 1000,
                  'currency': 'EUR',
                  'capacity': 2,
                  'bookedCount': 0,
                  'remainingSpots': 2,
                  'availabilityVersion': '0',
                },
                'plan': {
                  'id': 'p',
                  'activityId': 'a',
                  'itinerary': 'Meet by the river',
                },
                'host': {
                  'id': 'h',
                  'displayName': 'Host',
                  'summary': '',
                  'previousActivities': [],
                },
              },
            },
          );
        },
      ),
      store: store,
    );
    await controller.bootstrap();
    final openings = <Future<void>>[];
    final subscription = await wireInviteLinks(
      (link) => openings.add(controller.openLink(link)),
    );
    await Future.wait(openings);
    expect(controller.preview?.code, 'CODEAAAA');
    expect(controller.session, isNull);
    expect(events, isEmpty);
    controller.notePreviewDisplayed();
    await Future<void>.delayed(Duration.zero);
    expect(
      events.where((event) => event['type'] == 'invite_opened').single,
      containsPair('visitId', visit),
    );
    final delivered = Completer<void>();
    messenger.handlePlatformMessage(
      'com.llfbandit.app_links/events',
      const StandardMethodCodec().encodeSuccessEnvelope(
        'velio:///invite/CODEBBBB',
      ),
      (_) => delivered.complete(),
    );
    await delivered.future;
    await Future<void>.delayed(Duration.zero);
    await Future.wait(openings);
    expect(controller.preview?.code, 'CODEBBBB');
    expect((await store.load()).visitId, isNull);
    await controller.openCode(' codecccc ');
    expect(controller.preview?.code, 'CODECCCC');
    expect(controller.session, isNull);
    expect(requests.where((request) => request.startsWith('GET /invites/')), [
      'GET /invites/CODEAAAA',
      'GET /invites/CODEBBBB',
      'GET /invites/CODECCCC',
    ]);
    expect(
      requests.any((request) => request.contains('/demo/sessions')),
      isFalse,
    );
    expect(
      codeFromUri(Uri.parse('https://example.test/invite/CODEAAAA')),
      isNull,
    );
    expect(codeFromUri(Uri.parse('velio://other/CODEAAAA')), isNull);
    await subscription.cancel();
    controller.dispose();
    messenger.setMockMethodCallHandler(
      const MethodChannel('com.llfbandit.app_links/messages'),
      null,
    );
    messenger.setMockMethodCallHandler(
      const MethodChannel('com.llfbandit.app_links/events'),
      null,
    );
  });
}
