import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'device_store.dart';
import 'invite_links.dart';

/// One invite/identity/claim lifecycle owner (issue #19): manual code entry
/// and later link handoffs feed the same controller. Views render immutable
/// state snapshots; the controller owns mutation, reconciliation and
/// generation guards, and persistence never queues a claim.
///
/// Outcome rules (docs/client-contract.md §3/§4):
/// - Only a saved server booking confirms membership; a replay (created:false)
///   is the same saved booking and never re-haptics or re-records.
/// - After a lost response or 500 booking_outcome_unknown, the saved booking
///   is checked BEFORE another POST may be offered. Found -> confirmed.
///   Contractual 404 -> definitively absent. Unreachable -> unknown with an
///   explicit check-again action.
/// - A retry keeps the SAME operationId and the code bound at operation
///   start, keyed by person+activity, across remount and code changes.
/// - Every async callback is owned by captured token/run generations: a late
///   response can never confirm a replaced code or expire a newer identity.
class InviteController extends ChangeNotifier {
  InviteController({required this.api, required this.store});

  final VelioApi api;
  final DeviceStore store;
  StoredDevice? _device;

  String? _code;
  InvitePreview? _preview;
  bool _resolving = false;
  String? _resolveError;
  StoredSession? _session;
  String? _identityError;
  bool _identityBusy = false;
  ClaimPhase _claim = const ClaimIdle();

  int _codeGeneration = 0;
  int _claimRun = 0;
  int _identityRun = 0;
  bool _hapticPending = false;

  /// One observation set per displayed preview: invite_opened and
  /// activity_viewed use stable event ids; a later observation gets its own.
  String? _openedEventId;
  bool _observationEmitted = false;

  static const _openingOutcomes = {
    'claimable': 'available',
    'full': 'full',
    'expired': 'expired',
    'used': 'used',
  };

  String? get code => _code;
  InvitePreview? get preview => _preview;
  bool get resolving => _resolving;
  String? get resolveError => _resolveError;
  StoredSession? get session => _session;
  String? get identityError => _identityError;
  bool get identityBusy => _identityBusy;
  ClaimPhase get claimState => _claim;
  String? get visitorId => _device?.invitationVisitorId ?? _device?.visitorId;

  /// The controller holds one pending success haptic for a newly committed
  /// confirmation; the UI consumes it post-frame through the platform
  /// channel. A recovered or replayed booking never pends one.
  bool consumeSuccessHaptic() {
    final due = _hapticPending;
    _hapticPending = false;
    return due;
  }

  /// Boot: load durable facts, validate a saved credential against
  /// GET /demo/me, and re-open the retained code. A stale credential is
  /// dropped without losing the invite context; nothing is created silently.
  Future<void> bootstrap() async {
    final device = await store.load();
    _device = device;
    _session = device.session;
    _code = device.lastCode;
    final session = _session;
    if (session != null) {
      try {
        await api.me(session.token);
      } on ApiError catch (error) {
        if (error.isSessionError) {
          _session = null;
          device.session = null;
          await store.save();
        }
      } catch (_) {
        // Unreachable backend: keep the saved session until a real answer.
      }
      notifyListeners();
    }
    final code = _code;
    if (code != null && code.isNotEmpty) {
      await openCode(code);
    }
  }

  Future<void> openLink(InviteLink link) async {
    final device = _device ?? await store.load();
    _device = device;
    device.lastCode = link.code;
    device.visitId = link.visitId;
    device.invitationVisitorId = link.visitorId;
    await openCode(link.code);
  }

  /// Manual code entry and later link handoffs: one owner. A stale result
  /// after the code was replaced is discarded.
  Future<void> openCode(String raw) async {
    final code = raw.trim().toUpperCase();
    if (code.isEmpty) return;
    final generation = ++_codeGeneration;
    _code = code;
    _preview = null;
    _resolveError = null;
    _resolving = true;
    _claim = const ClaimIdle();
    _hapticPending = false;
    _openedEventId = null;
    _observationEmitted = false;
    notifyListeners();
    final device = _device ?? await store.load();
    _device = device;
    if (device.lastCode != code) {
      device.visitId = null;
      device.invitationVisitorId = null;
    }
    device.lastCode = code;
    await store.save();
    try {
      final preview = await api.resolveInvite(code);
      if (generation != _codeGeneration) return;
      _preview = preview;
      _resolving = false;
      notifyListeners();
      await _quietBookingCheck();
    } catch (error) {
      if (generation != _codeGeneration) return;
      _resolving = false;
      _resolveError = error is ApiError && error.status == 404
          ? 'This invitation code is not recognized.'
          : error is ApiError
          ? error.message
          : 'Could not open this invitation.';
      notifyListeners();
    }
  }

  /// Called by the UI in a post-frame callback once the preview facts are
  /// actually displayed; emits one stable activity_viewed and, for documented
  /// opening states only, one stable invite_opened. Telemetry never blocks.
  void notePreviewDisplayed() {
    final preview = _preview;
    if (preview == null || _observationEmitted) return;
    _observationEmitted = true;
    final visitor = visitorId;
    if (visitor == null) return;
    unawaited(
      api
          .emitEvent(
            type: 'activity_viewed',
            eventId: generateUuidV4(),
            visitorId: visitor,
            visitId: _device?.visitId,
            properties: {'activityId': preview.activity.id},
            token: _session?.token,
          )
          .catchError((_) {}),
    );
    final outcome = _openingOutcomes[preview.state];
    if (outcome == null) return;
    final openedId = _openedEventId ??= generateUuidV4();
    unawaited(
      api
          .emitEvent(
            type: 'invite_opened',
            eventId: openedId,
            visitorId: visitor,
            visitId: _device?.visitId,
            properties: {'inviteCode': preview.code, 'outcome': outcome},
            token: _session?.token,
          )
          .catchError((_) {}),
    );
  }

  /// Explicit identity selection: never automatic, never silently created.
  /// The invite code rides establishment so acquisition is recorded for a NEW
  /// person only; resuming never rewrites acquisition.
  Future<void> selectIdentity({
    required String contactKey,
    String displayName = '',
  }) async {
    if (_identityBusy || contactKey.trim().isEmpty) return;
    final run = ++_identityRun;
    final code = _code;
    _identityBusy = true;
    _identityError = null;
    notifyListeners();
    final device = _device ?? await store.load();
    _device = device;
    try {
      final establishment = await api.establishSession(
        contactKey: contactKey.trim(),
        displayName: displayName.trim(),
        inviteCode: code,
        visitorId: visitorId ?? device.visitorId,
        visitId: device.visitId,
      );
      if (run != _identityRun) return;
      final session = StoredSession(
        token: establishment.token,
        userId: establishment.user.id,
        displayName: establishment.user.displayName,
      );
      final accountChanged = _session?.userId != session.userId;
      _session = session;
      if (accountChanged) {
        _openedEventId = null;
        _observationEmitted = false;
      }
      device.session = session;
      await store.save();
      // Identity is owned: a pending uncertain claim of the previous person
      // can never attach; a fresh quiet check shows any saved receipt.
      _claimRun += 1;
      _claim = const ClaimIdle();
      _hapticPending = false;
      _identityBusy = false;
      notifyListeners();
      if (_preview != null) {
        await _quietBookingCheck();
      }
    } catch (error) {
      if (run != _identityRun) return;
      _identityBusy = false;
      _identityError = error is ApiError
          ? error.message
          : 'Could not select this identity.';
      notifyListeners();
    }
  }

  void signOut() {
    _identityRun += 1;
    _claimRun += 1;
    _session = null;
    _openedEventId = null;
    _observationEmitted = false;
    _claim = const ClaimIdle();
    _hapticPending = false;
    unawaited(() async {
      final device = _device ?? await store.load();
      _device = device;
      device.session = null;
      await store.save();
    }());
    notifyListeners();
  }

  /// Explicit claim (issue #19): the operation is persisted BEFORE the POST,
  /// the code bound at operation start stays bound across retries, and a
  /// pending request can never be mistaken for a confirmation.
  Future<void> claim() async {
    final preview = _preview;
    final session = _session;
    if (preview == null || session == null) return;
    if (_claim is ClaimSubmitting || _claim is ClaimChecking) return;
    if (_claim is ClaimRefused) {
      final refused = _claim as ClaimRefused;
      if (refused.retryAt?.isAfter(DateTime.now()) ?? false) return;
    }
    // Mark submitting synchronously: a second tap in the same event-loop
    // turn is already blocked before any await suspends this one.
    final run = ++_claimRun;
    _claim = const ClaimSubmitting();
    _hapticPending = false;
    notifyListeners();
    final device = _device ?? await store.load();
    _device = device;
    final key = '${session.userId}:${preview.activity.id}';
    final operation = device.operations[key];
    StoredOperation active;
    if (operation == null || operation.definitiveFailure) {
      active = StoredOperation(
        operationId: generateUuidV4(),
        inviteCode: preview.code,
      );
      device.operations[key] = active;
    } else {
      active = operation;
      active.inviteCode ??= preview.code;
    }
    await store.save();
    final visitor = visitorId;
    if (visitor != null) {
      unawaited(
        api
            .emitEvent(
              type: 'claim_started',
              eventId: generateUuidV4(),
              visitorId: visitor,
              visitId: _device?.visitId,
              properties: {'inviteCode': active.inviteCode},
              token: session.token,
            )
            .catchError((_) {}),
      );
    }
    try {
      final result = await api.bookActivity(
        session.token,
        preview.activity.id,
        active.operationId,
        inviteCode: active.inviteCode,
      );
      if (run != _claimRun) return;
      if (result.booking.activityId != preview.activity.id ||
          result.booking.userId != session.userId) {
        _claim = const ClaimUnknown(
          message:
              'The saved booking does not match your identity and activity.',
        );
        notifyListeners();
        return;
      }
      _setConfirmed(result.booking, newlyCreated: result.created);
    } catch (error) {
      if (run != _claimRun) return;
      if (error is! ApiError) {
        // Transport failure: the request may still have committed.
        await _reconcile(quiet: false);
        return;
      }
      if (error.isSessionError) {
        await _credentialLost(token: session.token);
        return;
      }
      switch (error.code) {
        case 'activity_sold_out':
          active.definitiveFailure = true;
          await store.save();
          _claim = const ClaimRefused(
            reason: 'sold-out',
            message:
                'This activity just filled — your attempt was not reserved.',
          );
        case 'activity_started':
          active.definitiveFailure = true;
          await store.save();
          _claim = const ClaimRefused(
            reason: 'started',
            message: 'This activity has already started.',
          );
        case 'request_limit':
          _claim = ClaimRefused(
            reason: 'rate-limited',
            message: 'Too many attempts. Please wait before trying again.',
            retryAfterSeconds: error.retryAfterSeconds,
          );
        case 'invite_expired':
          active.definitiveFailure = true;
          await store.save();
          _claim = const ClaimRefused(
            reason: 'invite-expired',
            message: 'This invitation has expired, so it cannot be claimed.',
          );
        case 'invite_not_found':
          _claim = const ClaimRefused(
            reason: 'invite-unknown',
            message: 'This invitation code is not recognized.',
          );
        case 'invite_recipient_mismatch':
          _claim = const ClaimRefused(
            reason: 'invite-mismatch',
            message: 'This invitation is for another email. Sign out and use the invited email.',
          );
        case 'booking_outcome_unknown':
          await _reconcile(quiet: false);
          return;
        default:
          await _reconcile(quiet: false);
          return;
      }
      notifyListeners();
    }
  }

  /// From unknown or refused-absent: check the saved booking again (never an
  /// automatic POST).
  Future<void> checkBooking() async {
    final claim = _claim;
    if (claim is ClaimUnknown ||
        (claim is ClaimRefused && claim.reason == 'absent')) {
      await _reconcile(quiet: false);
    }
  }

  Future<void> _quietBookingCheck() async {
    if (_session == null || _preview == null) return;
    await _reconcile(quiet: true);
  }

  Future<void> _reconcile({required bool quiet}) async {
    final preview = _preview;
    final session = _session;
    if (preview == null || session == null) return;
    final run = ++_claimRun;
    _claim = ClaimChecking(quiet: quiet);
    notifyListeners();
    try {
      final booking = await api.getMyBooking(
        session.token,
        preview.activity.id,
      );
      if (run != _claimRun) return;
      if (booking.activityId != preview.activity.id ||
          booking.userId != session.userId) {
        _claim = const ClaimUnknown(
          message:
              'The saved booking does not match your identity and activity.',
        );
        notifyListeners();
        return;
      }
      _setConfirmed(booking, newlyCreated: false);
    } on ApiError catch (error) {
      if (run != _claimRun) return;
      if (error.isSessionError) {
        await _credentialLost(token: session.token);
        return;
      }
      if (error.status == 404 && error.code == 'booking_not_found') {
        _claim = quiet
            ? const ClaimIdle()
            : const ClaimRefused(
                reason: 'absent',
                message: 'No saved booking was found for this activity — nothing was reserved.',
              );
        notifyListeners();
        return;
      }
      _claim = ClaimUnknown(
        message: 'Could not check your booking: ${error.message}',
      );
      notifyListeners();
    } catch (error) {
      if (run != _claimRun) return;
      _claim = ClaimUnknown(message: 'Could not check your booking: $error');
      notifyListeners();
    }
  }

  void _setConfirmed(BookingView booking, {required bool newlyCreated}) {
    _claim = ClaimConfirmed(booking: booking, created: newlyCreated);
    // Only a NEWLY committed confirmation may trigger the success haptic; a
    // recovered or replayed booking never does.
    _hapticPending = newlyCreated;
    notifyListeners();
  }

  Future<void> _credentialLost({required String token}) async {
    // An old 401 must never expire a replacement credential.
    if (_session != null && _session!.token != token) return;
    final device = _device ?? await store.load();
    _device = device;
    device.session = null;
    await store.save();
    _session = null;
    _identityRun += 1;
    _claimRun += 1;
    _claim = const ClaimIdle();
    _hapticPending = false;
    notifyListeners();
  }
}

sealed class ClaimPhase {
  const ClaimPhase();
}

class ClaimIdle extends ClaimPhase {
  const ClaimIdle();
}

class ClaimSubmitting extends ClaimPhase {
  const ClaimSubmitting();
}

class ClaimChecking extends ClaimPhase {
  const ClaimChecking({required this.quiet});
  final bool quiet;
}

class ClaimUnknown extends ClaimPhase {
  const ClaimUnknown({required this.message});
  final String message;
}

class ClaimConfirmed extends ClaimPhase {
  const ClaimConfirmed({required this.booking, required this.created});
  final BookingView booking;
  final bool created;
}

class ClaimRefused extends ClaimPhase {
  const ClaimRefused({
    required this.reason,
    required this.message,
    this.retryAfterSeconds,
  });
  final String reason;
  final String message;
  final int? retryAfterSeconds;

  DateTime? get retryAt => retryAfterSeconds == null
      ? null
      : DateTime.now().add(Duration(seconds: retryAfterSeconds!));
}
