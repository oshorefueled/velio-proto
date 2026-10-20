import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_screen.dart';
import 'package:velio/live_availability.dart';

/// Real-stack invitation claim on the simulator (ticket 07 demo, ticket 08
/// journey): the real preview and controller emit the opening, checkout
/// continuation, account entry and claim that the product reports read; a
/// new controller over the same device files, with no remembered invitation,
/// then returns to the saved booking through the account alone.
///
/// flutter test integration_test/invitation_claim_test.dart \
///   --dart-define=VELIO_API_BASE=http://localhost:3005 \
///   --dart-define=VELIO_INVITE_CODE=PUBLICCODE \
///   --dart-define=VELIO_GUEST_EMAIL=guest@example.test
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();

  const baseUrl = String.fromEnvironment('VELIO_API_BASE');
  const code = String.fromEnvironment('VELIO_INVITE_CODE');
  const email = String.fromEnvironment('VELIO_GUEST_EMAIL');

  Future<void> waitFor(WidgetTester tester, bool Function() done, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
      if (done()) return;
    }
    fail('timed out after ${seconds}s');
  }

  testWidgets('a new guest opens a public invitation, signs up in checkout and claims a spot', (tester) async {
    final directory = (await tester.runAsync(() => Directory.systemTemp.createTemp('velio-claim-')))!;
    InviteController launch() => InviteController(
      api: VelioApi(baseUrl: baseUrl),
      store: DeviceStore(directory: () async => directory),
      liveConnector: ioLiveConnector(baseUrl),
    );
    final controller = launch();
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: controller)));
    await tester.runAsync(controller.bootstrap);
    await tester.runAsync(() => controller.openCode(code));
    await waitFor(tester, () => controller.preview != null);
    expect(controller.preview!.state, 'claimable');
    // Let the post-frame display observation (invite_opened) go out.
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));

    controller.continueToCheckout();
    await tester.pump();
    await tester.runAsync(() => controller.selectIdentity(email: email, displayName: 'Demo Guest'));
    await waitFor(tester, () => controller.session != null);
    await tester.runAsync(controller.claim);
    await waitFor(tester, () => controller.claimState is ClaimConfirmed);
    final confirmed = controller.claimState as ClaimConfirmed;
    // ignore: avoid_print
    print('CLAIMED booking=${confirmed.booking.id} user=${controller.session!.userId}');
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(controller.store.save); // let pending device writes land
    controller.dispose();

    // Return later without the link: a new controller over the same device
    // files, with the remembered invitation code cleared, keeps the account
    // and finds the saved booking through the account alone.
    await tester.runAsync(() async {
      final files = DeviceStore(directory: () async => directory);
      (await files.load()).lastCode = null;
      await files.save();
    });
    final returned = launch();
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: returned)));
    await tester.runAsync(returned.bootstrap);
    await waitFor(tester, () => returned.savedBookings.isNotEmpty);
    expect(returned.session?.email, email);
    expect(returned.savedBookings.map((b) => b.id), contains(confirmed.booking.id));
    expect(returned.preview, isNull); // reached without reopening the invitation
    // ignore: avoid_print
    print('RETURNED saved=${returned.savedBookings.length}');
    await tester.pumpWidget(const SizedBox());
    returned.dispose();
  });
}
