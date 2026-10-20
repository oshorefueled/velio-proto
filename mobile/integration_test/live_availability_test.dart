import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_screen.dart';
import 'package:velio/live_availability.dart';

/// Real-stack live availability on the simulator (ticket 05): the actual
/// preview subscribes to GET /live on the local API, another account's
/// committed booking renders without manual refresh, and the rendered
/// version is acknowledged. The second phase waits for a booking committed
/// while this viewer was disconnected (driven externally by the run script)
/// and must recover it from a reconnect snapshot.
///
/// flutter test integration_test/live_availability_test.dart \
///   --dart-define=VELIO_API_BASE=http://localhost:3005 \
///   --dart-define=VELIO_INVITE_CODE=PUBLICCODE
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();

  const baseUrl = String.fromEnvironment('VELIO_API_BASE');
  const code = String.fromEnvironment('VELIO_INVITE_CODE');
  const awaitExternal = bool.fromEnvironment('VELIO_AWAIT_RECOVERY');

  Future<void> waitFor(WidgetTester tester, bool Function() done, {int seconds = 15}) async {
    for (var i = 0; i < seconds * 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (done()) return;
    }
    fail('timed out after ${seconds}s');
  }

  testWidgets('another account\'s booking renders on the preview and is acknowledged', (tester) async {
    final api = VelioApi(baseUrl: baseUrl);
    final controller = InviteController(
      api: api,
      store: DeviceStore.inMemory(),
      liveConnector: ioLiveConnector(baseUrl),
    );
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: controller)));
    await tester.runAsync(() => controller.openCode(code));
    await waitFor(tester, () => controller.preview != null);
    final before = controller.preview!.activity;
    // Let subscribe → subscribed → first snapshot settle on the real socket.
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
    await tester.pump();

    final stamp = DateTime.now().microsecondsSinceEpoch;
    final other = await tester.runAsync(
      () => api.establishSession(
        email: 'live-$stamp@example.test',
        displayName: 'Live Booker',
        visitorId: generateUuidV4(),
      ),
    );
    final booked = await tester.runAsync(
      () => api.bookActivity(other!.token, before.id, generateUuidV4()),
    );
    expect(booked!.created, isTrue);

    final expected = '${before.remainingSpots - 1} of ${before.capacity} spots left';
    await waitFor(tester, () => find.textContaining(expected).evaluate().isNotEmpty, seconds: 5);
    // ignore: avoid_print
    print('LIVE_RENDERED activity=${before.id} version=${controller.preview!.activity.availabilityVersion}');
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));

    if (awaitExternal) {
      // ignore: avoid_print
      print('LIVE_AWAITING_RECOVERY');
      final recovered = '${before.remainingSpots - 2} of ${before.capacity} spots left';
      for (var i = 0; i < 900 && find.textContaining(recovered).evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
        await tester.pump();
      }
      expect(find.textContaining(recovered), findsOneWidget);
      // ignore: avoid_print
      print('LIVE_RECOVERED version=${controller.preview!.activity.availabilityVersion}');
      await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
      await tester.pump();
    }
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
