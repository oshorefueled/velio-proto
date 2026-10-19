import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_links.dart';

/// Opt-in proof against an isolated real API, PostgreSQL and Redis. The server
/// must assign newly created activities to treatment. No widget or OS claim.
void main() {
  final base = Platform.environment['VELIO_HTTP_TEST_BASE'];
  test(
    'real email checkout survives restart, invalid credentials, Sign out and independent access; a lost HTTP response reconciles the committed booking',
    () async {
      final transport = VelioApi.ioTransport(base!);
      Future<Map<String, dynamic>> request(
        String method,
        String path, {
        Map<String, Object?>? body,
        String? token,
      }) async {
        final response = await transport(
          method,
          path,
          body: body == null ? null : jsonEncode(body),
          token: token,
        );
        expect(
          response.status,
          lessThan(400),
          reason: '$method $path: ${response.json}',
        );
        return (response.json as Map).cast<String, dynamic>();
      }

      final stamp = generateUuidV4();
      final email = 'checkout-$stamp+invited@example.test';
      final host = await request(
        'POST',
        '/demo/sessions',
        body: {
          'email': 'host-$stamp@example.test',
          'displayName': 'Checkout HTTP Host',
        },
      );
      final activity = await request(
        'POST',
        '/activities',
        token: host['session']['token'] as String,
        body: {
          'title': 'Ticket 04 HTTP checkout',
          'description': 'Synthetic isolated checkout verification.',
          'itinerary': 'Meet at the bridge. Walk together. Return.',
          'startsAt': DateTime.fromMillisecondsSinceEpoch(
            DateTime.now().millisecondsSinceEpoch,
            isUtc: true,
          ).add(const Duration(days: 2)).toIso8601String(),
          'timezone': 'Africa/Lagos',
          'priceMinorUnits': 1200,
          'currency': 'EUR',
          'spots': 5,
        },
      );
      final activityId = activity['activity']['id'] as String;
      final vouch = await request(
        'POST',
        '/activities/$activityId/invites',
        token: host['session']['token'] as String,
        body: {'rail': 'vouch', 'recipientEmail': '  ${email.toUpperCase()}  '},
      );
      final public = await request(
        'POST',
        '/activities/$activityId/invites',
        token: host['session']['token'] as String,
        body: {'rail': 'public_share'},
      );
      final directory = await Directory.systemTemp.createTemp(
        'velio-http-checkout-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final api = VelioApi(baseUrl: base);
      final store = DeviceStore(directory: () async => directory);
      var bookingPosts = 0;
      final observingApi = VelioApi(
        baseUrl: base,
        transport: (method, path, {body, token}) {
          if (method == 'POST' && path.endsWith('/bookings')) bookingPosts += 1;
          return transport(method, path, body: body, token: token);
        },
      );
      final controller = InviteController(api: observingApi, store: store);
      await controller.bootstrap();
      final visitor = generateUuidV4();
      final visit = generateUuidV4();
      await controller.openLink(
        InviteLink(
          vouch['invite']['code'] as String,
          visitorId: visitor,
          visitId: visit,
        ),
      );
      controller.continueToCheckout();
      await controller.selectIdentity(email: 'wrong-$stamp@example.test');
      expect(controller.identityError, contains('different email'));
      expect(controller.session, isNull);
      await controller.selectIdentity(email: '  ${email.toUpperCase()}  ');
      expect(controller.session!.email, email);
      expect(bookingPosts, 0, reason: 'account entry never books');
      await controller.claim();
      final confirmation = controller.claimState as ClaimConfirmed;
      expect(confirmation.created, true);
      expect(confirmation.booking.rail, 'vouch');
      expect(controller.consumeSuccessHaptic(), true);
      expect(bookingPosts, 1);

      final resumed = InviteController(
        api: observingApi,
        store: DeviceStore(directory: () async => directory),
      );
      await resumed.bootstrap();
      expect(resumed.session!.userId, controller.session!.userId);
      expect(
        (resumed.claimState as ClaimConfirmed).booking.id,
        confirmation.booking.id,
      );
      expect(resumed.consumeSuccessHaptic(), false);
      expect(bookingPosts, 1);

      // The real API rejects this persisted credential, then restores the same
      // remembered email through /demo/sessions. No fabricated API receipt.
      final device = await resumed.store.load();
      device.session = StoredSession(
        token: 'invalidated-credential',
        userId: resumed.session!.userId,
        displayName: resumed.session!.displayName,
        email: resumed.session!.email,
      );
      await resumed.store.save();
      final restored = InviteController(
        api: observingApi,
        store: DeviceStore(directory: () async => directory),
      );
      await restored.bootstrap();
      expect(restored.session!.userId, controller.session!.userId);
      expect(restored.session!.token, isNot('invalidated-credential'));
      expect(bookingPosts, 1);
      restored.signOut();
      await restored.store.save();
      final signedOut = InviteController(
        api: observingApi,
        store: DeviceStore(directory: () async => directory),
      );
      await signedOut.bootstrap();
      expect(signedOut.session, isNull);

      // Independent return does not even have the original invitation context.
      final independent = InviteController(
        api: observingApi,
        store: DeviceStore.inMemory(),
      );
      await independent.selectIdentity(email: email, independent: true);
      expect(independent.code, isNull);
      expect(independent.session!.userId, controller.session!.userId);
      expect(independent.savedBookings.single.id, confirmation.booking.id);
      await independent.openSavedBooking(independent.savedBookings.single);
      expect(
        independent.savedDetails!.plan.itinerary,
        'Meet at the bridge. Walk together. Return.',
      );
      expect(independent.savedDetails!.host.displayName, 'Checkout HTTP Host');
      expect(independent.savedReceipt!.id, confirmation.booking.id);
      expect(bookingPosts, 1);

      var dropped = false;
      var lostPosts = 0;
      final lostApi = VelioApi(
        baseUrl: base,
        transport: (method, path, {body, token}) async {
          final response = await transport(
            method,
            path,
            body: body,
            token: token,
          );
          if (method == 'POST' && path.endsWith('/bookings')) {
            lostPosts += 1;
            expect(
              response.status,
              201,
              reason: 'the injected fault must follow a real new commit',
            );
            dropped = true;
            throw const SocketException('response dropped after server commit');
          }
          return response;
        },
      );
      final lost = InviteController(
        api: lostApi,
        store: DeviceStore.inMemory(),
      );
      await lost.openCode(public['invite']['code'] as String);
      lost.continueToCheckout();
      await lost.selectIdentity(email: 'public-$stamp@example.test');
      await lost.claim();
      expect(dropped, true);
      expect(lostPosts, 1);
      expect((lost.claimState as ClaimConfirmed).created, false);
      expect(lost.consumeSuccessHaptic(), false);
      final saved = await api.getMyBooking(lost.session!.token, activityId);
      expect(saved.id, (lost.claimState as ClaimConfirmed).booking.id);

      // Exact IDs for optional PostgreSQL/event inspection and the later UI demo.
      await Directory('../.tickets').create(recursive: true);
      await File('../.tickets/04-http-fixtures.json').writeAsString(
        const JsonEncoder.withIndent('  ').convert({
          'apiBase': base,
          'activityId': activityId,
          'hostId': host['user']['id'],
          'invitedUserId': controller.session!.userId,
          'publicUserId': lost.session!.userId,
          'email': email,
          'bookingId': confirmation.booking.id,
          'publicBookingId': saved.id,
          'vouchCode': vouch['invite']['code'],
          'publicCode': public['invite']['code'],
          'visitorId': visitor,
          'visitId': visit,
        }),
      );
    },
    skip: base == null
        ? 'Set VELIO_HTTP_TEST_BASE to an isolated treatment API to run real HTTP proof.'
        : false,
  );
}
