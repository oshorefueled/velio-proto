import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/api.dart';
import 'package:velio/device_store.dart';
import 'package:velio/invite_controller.dart';
import 'package:velio/invite_screen.dart';
import 'package:velio/live_availability.dart';

/// A rendered Flutter viewer for the multi-client latency run (ticket 08):
/// keeps one invitation preview visible and subscribed for a fixed time so
/// externally driven bookings are measured against an actual app that
/// acknowledges only after its frame renders each version.
///
/// flutter test integration_test/live_viewer_hold_test.dart \
///   --dart-define=VELIO_API_BASE=http://localhost:3005 \
///   --dart-define=VELIO_INVITE_CODE=PUBLICCODE --dart-define=VELIO_HOLD_SECONDS=90
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();

  const baseUrl = String.fromEnvironment('VELIO_API_BASE');
  const code = String.fromEnvironment('VELIO_INVITE_CODE');
  const holdSeconds = int.fromEnvironment('VELIO_HOLD_SECONDS', defaultValue: 90);

  testWidgets('holds a live invitation preview visible', (tester) async {
    final controller = InviteController(
      api: VelioApi(baseUrl: baseUrl),
      store: DeviceStore.inMemory(),
      liveConnector: ioLiveConnector(baseUrl),
    );
    await tester.pumpWidget(MaterialApp(home: InviteScreen(controller: controller)));
    await tester.runAsync(() => controller.openCode(code));
    for (var i = 0; i < 100 && controller.preview == null; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(controller.preview, isNotNull);
    // Let register_measurement, subscribe and the first snapshot complete.
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 3)));
    await tester.pump();
    // ignore: avoid_print
    print('VIEWER_READY version=${controller.preview!.activity.availabilityVersion}');
    final until = DateTime.now().add(const Duration(seconds: holdSeconds));
    while (DateTime.now().isBefore(until)) {
      // Frames are pumped continuously so every applied version renders
      // (and is acknowledged post-frame) as it would on a device.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    // ignore: avoid_print
    print('VIEWER_DONE version=${controller.preview!.activity.availabilityVersion} remaining=${controller.preview!.activity.remainingSpots}');
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
