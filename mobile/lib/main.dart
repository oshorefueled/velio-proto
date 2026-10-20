import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;

import 'device_store.dart';
import 'api.dart';
import 'invite_controller.dart';
import 'invite_links.dart';
import 'invite_screen.dart';
import 'live_availability.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();
  // Emulator/LAN base (mobile/README.md): the iOS simulator shares the Mac
  // loopback, so http://localhost:3001 reaches the local backend directly;
  // Android emulators use http://10.0.2.2:3001. Override with
  // --dart-define=VELIO_API_BASE=<url>.
  const baseUrl = String.fromEnvironment(
    'VELIO_API_BASE',
    defaultValue: 'http://localhost:3001',
  );
  final supportDirectory = await getApplicationSupportDirectory();
  final store = DeviceStore(directory: () async => supportDirectory);
  final controller = InviteController(
    api: VelioApi(baseUrl: baseUrl),
    store: store,
    liveConnector: ioLiveConnector(baseUrl),
  );
  await controller.bootstrap();
  await wireInviteLinks((link) => unawaited(controller.openLink(link)));
  runApp(VelioApp(controller: controller));
}

class VelioApp extends StatelessWidget {
  const VelioApp({super.key, required this.controller});

  final InviteController controller;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Velio',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: green,
          primary: green,
          surface: Colors.white,
        ),
        scaffoldBackgroundColor: const Color(0xFFF9FAF9),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: lime,
            foregroundColor: limeInk,
            minimumSize: const Size.fromHeight(50),
            shape: const StadiumBorder(),
            textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: ink,
            minimumSize: const Size.fromHeight(48),
            shape: const StadiumBorder(),
            side: const BorderSide(color: Color(0xFFD0D5DD)),
            textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      home: InviteScreen(controller: controller),
    );
  }
}
