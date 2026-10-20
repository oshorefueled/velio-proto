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

/// Real-stack offline reopen and recovery on the simulator (ticket 06). The
/// run script stops the API after OFFLINE_READY (the app sees a transport
/// failure, as when offline), fills the activity through a second instance
/// and restores the API after CLAIM_REFUSED_OFFLINE.
///
/// flutter test integration_test/offline_recovery_test.dart \
///   --dart-define=VELIO_API_BASE=http://localhost:3005 \
///   --dart-define=VELIO_INVITE_CODE=PUBLICCODE
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();

  const baseUrl = String.fromEnvironment('VELIO_API_BASE');
  const code = String.fromEnvironment('VELIO_INVITE_CODE');

  Future<void> waitFor(WidgetTester tester, bool Function() done, {int seconds = 30}) async {
    for (var i = 0; i < seconds * 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
      if (done()) return;
    }
    fail('timed out after ${seconds}s');
  }

  final screenList = find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first;

  InviteController controllerOver(Directory directory) => InviteController(
    api: VelioApi(baseUrl: baseUrl),
    store: DeviceStore(directory: () async => directory),
    liveConnector: ioLiveConnector(baseUrl),
  );

  testWidgets('cached details reopen offline, refuse a claim, and refresh to sold out after reconnecting', (tester) async {
    final directory = (await tester.runAsync(() => Directory.systemTemp.createTemp('velio-offline-')))!;

    // Online: load the invitation once on this device.
    final online = controllerOver(directory);
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: online)));
    await tester.runAsync(online.bootstrap);
    await tester.runAsync(() => online.openCode(code));
    await waitFor(tester, () => online.preview != null && online.cachedAt == null);
    expect(online.preview!.state, 'claimable');
    await tester.pumpWidget(const SizedBox());
    online.dispose();
    // ignore: avoid_print
    print('OFFLINE_READY');

    // The script takes the API away; wait until it is unreachable.
    final api = Uri.parse(baseUrl);
    for (var i = 0; i < 120; i++) {
      final reachable = await tester.runAsync(() async {
        try {
          (await Socket.connect(api.host, api.port, timeout: const Duration(milliseconds: 300))).destroy();
          return true;
        } on SocketException {
          return false;
        }
      });
      if (reachable == false) break;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 500)));
    }

    // Reopen as a fresh app process over the same device files.
    final reopened = controllerOver(directory);
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: reopened)));
    await tester.runAsync(reopened.bootstrap);
    await waitFor(tester, () => reopened.preview != null);
    expect(reopened.cachedAt, isNotNull);
    expect(find.byKey(const Key('offline-banner')), findsOneWidget);
    expect(find.text(reopened.preview!.activity.title), findsOneWidget);

    expect(reopened.preview!.state, 'claimable'); // cached facts still offer it
    reopened.continueToCheckout();
    await tester.pump();
    await tester.scrollUntilVisible(find.byKey(const Key('offline-notice')), 200, scrollable: screenList);
    expect(find.byKey(const Key('offline-notice')), findsOneWidget);
    expect(reopened.checkout, isFalse);
    expect((await tester.runAsync(reopened.store.load))!.operations, isEmpty);
    // ignore: avoid_print
    print('CLAIM_REFUSED_OFFLINE');

    // The script fills the activity elsewhere and restores the API.
    await waitFor(tester, () => reopened.cachedAt == null, seconds: 90);
    await waitFor(tester, () => reopened.preview!.state == 'full', seconds: 15);
    expect(find.byKey(const Key('offline-banner')), findsNothing);
    final fullExplanation = find.text('The activity is full — every spot is taken.');
    await tester.scrollUntilVisible(fullExplanation, 200, scrollable: screenList);
    expect(fullExplanation, findsOneWidget);
    expect(find.byKey(const Key('continue-checkout')), findsNothing);
    expect(reopened.claimState, isA<ClaimIdle>());
    expect(reopened.preview!.activity.remainingSpots, 0);
    // ignore: avoid_print
    print('RECOVERED_FULL remaining=${reopened.preview!.activity.remainingSpots}');
    await tester.pumpWidget(const SizedBox());
    reopened.dispose();
  });
}
