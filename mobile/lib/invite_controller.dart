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
  bool _checkout = false;
  bool _retryEligible = false;
  List<SavedBookingSummary> _savedBookings = [];
  ActivityDetails? _savedDetails;
  BookingView? _savedReceipt;
  bool _savedBusy = false;
  String? _savedError;
  int _savedRun = 0;

  bool get checkout => _checkout;
  List<SavedBookingSummary> get savedBookings =>
      List.unmodifiable(_savedBookings);
  ActivityDetails? get savedDetails => _savedDetails;
  BookingView? get savedReceipt => _savedReceipt;
  bool get savedBusy => _savedBusy;
  String? get savedError => _savedError;

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

  /// Validate persisted access and migrate legacy files through the server's
  /// account representation. Network failure retains the remembered account.
  Future<void> bootstrap() async {
    final run = _identityRun;
    final codeGeneration = _codeGeneration;
    final device = await store.load();
    if (run != _identityRun) return;
    _device = device;
    _session = device.session;
    _code = device.lastCode;
    final session = _session;
    if (session != null) {
      try {
        final user = await api.me(session.token);
        if (run != _identityRun || _session?.token != session.token) return;
        if (user.id != session.userId) {
          throw StateError('Account did not match');
        }
        _session = StoredSession(
          token: session.token,
          userId: user.id,
          displayName: user.displayName,
          email: user.email,
        );
        device.session = _session;
        await store.save();
      } on ApiError catch (error) {
        if (run != _identityRun || _session?.token != session.token) return;
        if (error.isSessionError) {
          await _credentialLost(token: session.token);
        } else {
          _identityError = 'Could not verify account access. Your account is remembered; retry when connected.';
        }
      } catch (_) {
        if (run != _identityRun) return;
        _identityError = 'Could not verify account access. Your account is remembered; retry when connected.';
      }
    }
    if (run != _identityRun) return;
    notifyListeners();
    if (codeGeneration == _codeGeneration &&
        _code != null &&
        _code!.isNotEmpty) {
      await openCode(_code!);
    }
    if (_session != null) await loadSavedBookings();
  }

  /// Checkout is a deliberate observation, independent of account entry.
  void continueToCheckout() {
    final preview = _preview;
    if (preview == null || _checkout || preview.state != 'claimable') return;
    _checkout = true;
    final visitor = visitorId;
    if (visitor != null) {
      unawaited(
        api
            .emitEvent(
              type: 'claim_started',
              eventId: generateUuidV4(),
              visitorId: visitor,
              visitId: _device?.visitId,
              properties: {'inviteCode': preview.code},
              token: _session?.token,
            )
            .catchError((_) {}),
      );
    }
    notifyListeners();
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
    if (_identityBusy) {
      _identityRun += 1;
      _identityBusy = false;
    }
    _code = code;
    _claimRun += 1;
    _checkout = false;
    _retryEligible = false;
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
    if (generation != _codeGeneration) return;
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
    required String email,
    bool independent = false,
    String displayName = '',
  }) async {
    if (_identityBusy || email.trim().isEmpty) return;
    final run = ++_identityRun;
    final code = independent ? null : _code;
    _claimRun += 1;
    _savedRun += 1;
    _savedBookings = [];
    _savedDetails = null;
    _savedReceipt = null;
    _savedError = null;
    _savedBusy = false;
    _claim = const ClaimIdle();
    _retryEligible = false;
    _identityBusy = true;
    _identityError = null;
    notifyListeners();
    final device = _device ?? await store.load();
    _device = device;
    if (run != _identityRun) return;
    try {
      final establishment = await api.establishSession(
        email: email.trim(),
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
        email: establishment.user.email,
      );
      final accountChanged = _session?.userId != session.userId;
      _session = session;
      if (accountChanged) {
        _openedEventId = null;
        _observationEmitted = false;
      }
      device.session = session;
      await store.save();
      if (run != _identityRun) return;
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
      if (run == _identityRun) await loadSavedBookings();
    } catch (error) {
      if (run != _identityRun) return;
      _identityBusy = false;
      _identityError = error is ApiError
          ? error.message
          : 'Could not sign in. Your invitation is retained.';
      notifyListeners();
    }
  }

  void signOut() {
    _identityRun += 1;
    _claimRun += 1;
    _savedRun += 1;
    _session = null;
    _identityBusy = false;
    _identityError = null;
    _savedBookings = [];
    _savedDetails = null;
    _savedReceipt = null;
    _savedBusy = false;
    _savedError = null;
    _retryEligible = false;
    _openedEventId = null;
    _observationEmitted = false;
    _claim = const ClaimIdle();
    _hapticPending = false;
    final device = _device;
    if (device != null) {
      device.session = null;
      unawaited(store.save());
    }
    notifyListeners();
  }

  Future<void> loadSavedBookings() async {
    final session = _session;
    if (session == null) return;
    final run = ++_savedRun;
    _savedBusy = true;
    _savedError = null;
    notifyListeners();
    try {
      final bookings = await api.getMyBookings(session.token);
      if (run != _savedRun || _session?.token != session.token) return;
      _savedBookings = bookings;
    } catch (error) {
      if (run != _savedRun || _session?.token != session.token) return;
      if (error is ApiError && error.isSessionError) {
        _savedBusy = false;
        await _credentialLost(token: session.token);
        return;
      }
      _savedError = 'Could not load saved bookings. Please retry.';
    }
    if (run != _savedRun) return;
    _savedBusy = false;
    notifyListeners();
  }

  Future<void> openSavedBooking(SavedBookingSummary summary) async {
    final session = _session;
    if (session == null) return;
    final run = ++_savedRun;
    _savedDetails = null;
    _savedReceipt = null;
    _savedBusy = true;
    _savedError = null;
    notifyListeners();
    try {
      final receipt = await api.getMyBooking(session.token, summary.activityId);
      final details = await api.getActivity(summary.activityId);
      if (run != _savedRun || _session?.token != session.token) return;
      if (receipt.userId != session.userId ||
          receipt.id != summary.id ||
          receipt.activityId != details.activity.id ||
          receipt.planId != details.plan.id ||
          receipt.planId != summary.planId) {
        throw StateError('Saved booking did not match');
      }
      _savedDetails = details;
      _savedReceipt = receipt;
    } catch (error) {
      if (run != _savedRun || _session?.token != session.token) return;
      if (error is ApiError && error.isSessionError) {
        _savedBusy = false;
        await _credentialLost(token: session.token);
        return;
      }
      _savedError = 'Could not open this saved booking. Select it to retry.';
    }
    if (run != _savedRun) return;
    _savedBusy = false;
    notifyListeners();
  }

  Future<void> restoreAccess() async {
    final session = _session;
    if (session == null || _identityBusy) return;
    await _credentialLost(token: session.token);
    if (_session != null && _identityError == null) {
      await _quietBookingCheck();
      await loadSavedBookings();
    }
  }

  /// Explicit claim (issue #19): the operation is persisted BEFORE the POST,
  /// the code bound at operation start stays bound across retries, and a
  /// pending request can never be mistaken for a confirmation.
  Future<void> claim() async {
    final preview = _preview;
    final session = _session;
    if (preview == null ||
        session == null ||
        _identityBusy ||
        _identityError != null) {
      return;
    }
    if (_claim is ClaimSubmitting ||
        _claim is ClaimChecking ||
        _claim is ClaimUnknown ||
        _claim is ClaimConfirmed) {
      return;
    }
    if (_claim is ClaimRefused) {
      final refused = _claim as ClaimRefused;
      if (refused.retryAt?.isAfter(DateTime.now()) ?? false) return;
    }
    if (preview.state != 'claimable' || preview.activity.remainingSpots <= 0) {
      return;
    }
    final existing =
        _device?.operations['${session.userId}:${preview.activity.id}'];
    if (existing != null && !existing.definitiveFailure && !_retryEligible) {
      await _reconcile(quiet: false);
      return;
    }
    _retryEligible = false;
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
    if (run != _claimRun || _session?.token != session.token) return;
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
          if (run != _claimRun) return;
          _claim = const ClaimRefused(
            reason: 'sold-out',
            message:
                'This activity just filled — your attempt was not reserved.',
          );
          try {
            final refreshed = await api.resolveInvite(preview.code);
            if (run != _claimRun) return;
            _preview = refreshed;
          } catch (_) {
            if (run != _claimRun) return;
            _resolveError = 'Could not refresh availability. Your booking was not saved; retry the invitation preview.';
          }
        case 'activity_started':
          active.definitiveFailure = true;
          await store.save();
          if (run != _claimRun) return;
          _claim = const ClaimRefused(
            reason: 'started',
            message: 'This activity has already started.',
          );
        case 'request_limit':
          _claim = ClaimRefused(
            reason: 'rate-limited',
            message: 'Too many attempts. Please wait before trying again.',
            retryAfterSeconds: error.retryAfterSeconds,
            retryAt: error.retryAfterSeconds == null
                ? null
                : DateTime.now().add(
                    Duration(seconds: error.retryAfterSeconds!),
                  ),
          );
        case 'invite_expired':
          active.definitiveFailure = true;
          await store.save();
          if (run != _claimRun) return;
          _claim = const ClaimRefused(
            reason: 'invite-expired',
            message: 'This invitation has expired, so it cannot be claimed.',
          );
        case 'invite_not_found':
          active.definitiveFailure = true;
          await store.save();
          if (run != _claimRun) return;
          _claim = const ClaimRefused(
            reason: 'invite-unknown',
            message: 'This invitation code is not recognized.',
          );
        case 'invite_used':
          active.definitiveFailure = true;
          await store.save();
          if (run != _claimRun) return;
          _claim = const ClaimRefused(
            reason: 'invite-used',
            message: 'This personal invitation has already been used.',
          );
        case 'invite_recipient_mismatch':
          active.definitiveFailure = true;
          await store.save();
          if (run != _claimRun) return;
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
        final operation =
            _device?.operations['${session.userId}:${preview.activity.id}'];
        if (operation != null && !operation.definitiveFailure) {
          try {
            final refreshed = await api.resolveInvite(
              operation.inviteCode ?? preview.code,
            );
            if (run != _claimRun) return;
            if (refreshed.activity.id != preview.activity.id) {
              throw StateError('Invitation did not match');
            }
            _retryEligible =
                refreshed.state == 'claimable' &&
                refreshed.activity.remainingSpots > 0;
            if (_preview?.code == refreshed.code) _preview = refreshed;
            _claim = ClaimRefused(
              reason: _retryEligible ? 'absent' : 'unavailable',
              message: _retryEligible
                  ? 'No saved booking was found. Review the refreshed details before confirming again.'
                  : 'No saved booking was found. This invitation is now ${refreshed.state}; confirmation is unavailable.',
            );
          } catch (_) {
            if (run != _claimRun) return;
            _retryEligible = false;
            _claim = const ClaimUnknown(
              message: 'No saved booking was found, but invitation eligibility could not be refreshed. Check again when connected.',
            );
          }
        } else {
          _claim = quiet
              ? const ClaimIdle()
              : const ClaimRefused(
                  reason: 'absent',
                  message: 'No saved booking was found for this activity.',
                );
        }
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
    if (newlyCreated) unawaited(loadSavedBookings());
  }

  Future<void> _credentialLost({required String token}) async {
    final remembered = _session;
    if (remembered == null || remembered.token != token || _identityBusy) {
      return;
    }
    final run = _identityRun;
    _claimRun += 1;
    _savedRun += 1;
    _claim = const ClaimIdle();
    _savedDetails = null;
    _savedReceipt = null;
    _savedBusy = false;
    _hapticPending = false;
    _retryEligible = false;
    if (remembered.email == null) {
      // Old files cannot reconstruct an email from a user id or display name.
      _session = null;
      _device?.session = null;
      _savedBookings = [];
      _identityError = 'Your previous session expired. Sign in with your email to restore access.';
      await store.save();
      if (run == _identityRun) notifyListeners();
      return;
    }
    _identityBusy = true;
    _identityError = null;
    notifyListeners();
    try {
      final result = await api.establishSession(
        email: remembered.email!,
        visitorId: visitorId ?? _device!.visitorId,
        visitId: _device?.visitId,
      );
      if (run != _identityRun || _session?.token != token) return;
      if (result.created || result.user.id != remembered.userId) {
        throw StateError('Account did not match');
      }
      _session = StoredSession(
        token: result.token,
        userId: result.user.id,
        displayName: result.user.displayName,
        email: result.user.email,
      );
      _device?.session = _session;
      await store.save();
    } catch (_) {
      if (run != _identityRun || _session?.token != token) return;
      _identityError = 'Could not restore account access. Your account is remembered; retry when connected.';
    }
    if (run != _identityRun) return;
    _identityBusy = false;
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
    this.retryAt,
  });
  final String reason;
  final String message;
  final int? retryAfterSeconds;

  final DateTime? retryAt;
}
