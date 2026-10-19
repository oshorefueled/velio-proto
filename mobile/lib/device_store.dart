import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Canonical lowercase UUID v4 (backend validation requires the shape).
String generateUuidV4() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0F) | 0x40;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Durable device facts (issue #19): stable visitor UUID, finite saved demo
/// session, last entered code and the per person/activity uncertain claim
/// operations. Persistence never queues a claim — restoring state only
/// re-opens context that the person acts on explicitly.
class StoredOperation {
  StoredOperation({
    required this.operationId,
    this.inviteCode,
    this.definitiveFailure = false,
  });
  final String operationId;
  String? inviteCode;
  bool definitiveFailure = false;

  Map<String, Object?> toJson() => {
    'operationId': operationId,
    if (inviteCode != null) 'inviteCode': inviteCode,
    if (definitiveFailure) 'definitiveFailure': true,
  };

  static StoredOperation fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return StoredOperation(
      operationId: map['operationId'] as String,
      inviteCode: map['inviteCode'] as String?,
      definitiveFailure: map['definitiveFailure'] as bool? ?? false,
    );
  }
}

class StoredSession {
  StoredSession({
    required this.token,
    required this.userId,
    required this.displayName,
    this.email,
  });
  final String token;
  final String userId;
  final String displayName;
  final String? email;

  Map<String, Object?> toJson() => {
    'token': token,
    'userId': userId,
    'displayName': displayName,
    if (email != null) 'email': email,
  };

  static StoredSession fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return StoredSession(
      token: map['token'] as String,
      userId: map['userId'] as String,
      displayName: map['displayName'] as String,
      email: map['email'] as String?,
    );
  }
}

class StoredDevice {
  StoredDevice({
    required this.visitorId,
    this.session,
    this.lastCode,
    this.visitId,
    this.invitationVisitorId,
    Map<String, StoredOperation> operations = const {},
  }) : operations = Map.of(operations);
  final String visitorId;
  StoredSession? session;
  String? lastCode;
  String? visitId;
  String? invitationVisitorId;
  final Map<String, StoredOperation> operations;

  Map<String, Object?> toJson() => {
    'visitorId': visitorId,
    if (session != null) 'session': session!.toJson(),
    if (lastCode != null) 'lastCode': lastCode,
    if (visitId != null) 'visitId': visitId,
    if (invitationVisitorId != null) 'invitationVisitorId': invitationVisitorId,
    'operations': operations.map((key, value) => MapEntry(key, value.toJson())),
  };

  static StoredDevice fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    final operations = ((map['operations'] as Map?) ?? {})
        .cast<String, dynamic>()
        .map((key, value) => MapEntry(key, StoredOperation.fromJson(value)));
    return StoredDevice(
      visitorId: map['visitorId'] as String,
      session: map['session'] == null
          ? null
          : StoredSession.fromJson(map['session']),
      lastCode: map['lastCode'] as String?,
      visitId: map['visitId'] as String?,
      invitationVisitorId: map['invitationVisitorId'] as String?,
      operations: operations,
    );
  }
}

/// File-backed store; the directory is injectable so tests use a temp
/// directory while the app uses the platform documents/support directory.
class DeviceStore {
  DeviceStore({required this.directory}) : _memoryOnly = false;

  /// Widget tests run in FakeAsync where real file IO cannot complete; an
  /// in-memory store keeps the same lifecycle without IO.
  DeviceStore.inMemory()
    : directory = (() => throw UnimplementedError()),
      _memoryOnly = true;

  /// Injectable so tests use a temp directory; the app passes the platform
  /// support directory from path_provider.
  final Future<Directory> Function() directory;
  final bool _memoryOnly;
  StoredDevice? _loaded;

  Future<StoredDevice> load() async {
    if (_loaded != null) return _loaded!;
    if (_memoryOnly) {
      _loaded = StoredDevice(visitorId: generateUuidV4());
      return _loaded!;
    }
    final file = await _file();
    if (await file.exists()) {
      try {
        _loaded = StoredDevice.fromJson(jsonDecode(await file.readAsString()));
        return _loaded!;
      } catch (_) {
        // A corrupt store is replaced by a fresh one below.
      }
    }
    _loaded = StoredDevice(visitorId: generateUuidV4());
    await save();
    return _loaded!;
  }

  Future<void> _writes = Future.value();

  Future<void> save() {
    final write = _writes.then((_) => _save());
    _writes = write.catchError((_) {});
    return write;
  }

  Future<void> _save() async {
    final device = _loaded;
    if (device == null || _memoryOnly) return;
    final file = await _file();
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(device.toJson()));
  }

  Future<File> _file() async {
    final dir = await directory();
    await dir.create(recursive: true);
    return File('${dir.path}${Platform.pathSeparator}velio-device.json');
  }
}
