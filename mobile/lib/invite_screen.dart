import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

import 'invite_controller.dart';

/// The single invite screen (issue #19): permanent manual code entry at the
/// top (also the link-failure fallback), the displayed preview before any
/// identity, explicit identity selection, explicit claim with recovery, and
/// the saved receipt which wins even when the invite turns unusable.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key, required this.controller});

  final InviteController controller;

  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen>
    with WidgetsBindingObserver {
  final _codeField = TextEditingController();
  final _contactField = TextEditingController();
  String? _displayedCode;
  bool _independentSignIn = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_onControllerChanged);
    _displayedCode = widget.controller.code;
    _codeField.text = _displayedCode ?? '';
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.controller.notePreviewDisplayed();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_onControllerChanged);
    _codeField.dispose();
    _contactField.dispose();
    super.dispose();
  }

  void _onControllerChanged() {
    if (_displayedCode != widget.controller.code) {
      _displayedCode = widget.controller.code;
      _codeField.text = _displayedCode ?? '';
    }
    // Telemetry observes displayed preview facts after the frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.controller.notePreviewDisplayed();
      // Rendered-availability acknowledgement follows the committed frame.
      widget.controller.noteAvailabilityRendered();
    });
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.controller.setForeground(state == AppLifecycleState.resumed);
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Scaffold(
      appBar: AppBar(title: const Text('Velio — claim your spot')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (!controller.checkout && controller.session != null)
              _IdentityCard(
                controller: controller,
                contactField: _contactField,
              ),
            if (controller.session == null && !controller.checkout) ...[
              TextButton(
                key: const Key('independent-sign-in'),
                onPressed: () =>
                    setState(() => _independentSignIn = !_independentSignIn),
                child: const Text('Sign in to saved bookings'),
              ),
              if (_independentSignIn)
                _IdentityCard(
                  controller: controller,
                  contactField: _contactField,
                  independent: true,
                ),
            ],
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('code-field'),
                    controller: _codeField,
                    decoration: const InputDecoration(
                      labelText: 'Invite code',
                      hintText: 'Enter or paste the code',
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (value) => controller.openCode(value),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('open-code'),
                  onPressed: controller.resolving
                      ? null
                      : () => controller.openCode(_codeField.text),
                  child: const Text('Open'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text(
              'Manual code entry always works here — links simply fill it for you.',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 16),
            if (controller.resolving) const LinearProgressIndicator(),
            if (controller.resolveError != null)
              Card(
                color: const Color(0xFFFFF4E5),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        controller.resolveError!,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        key: const Key('retry-resolve'),
                        onPressed: controller.code == null
                            ? null
                            : () => controller.openCode(controller.code!),
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
            if (controller.preview != null && controller.cachedAt != null)
              Card(
                key: const Key('offline-banner'),
                color: const Color(0xFFFFF4E5),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'You are offline',
                        style: TextStyle(fontWeight: FontWeight.w600),
                      ),
                      Text(
                        'Saved ${DateFormat.yMMMd().add_jm().format(controller.cachedAt!.toLocal())}. '
                        'Availability may have changed since then.',
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        key: const Key('refresh-preview'),
                        onPressed: controller.refreshing
                            ? null
                            : () => controller.refreshPreview(),
                        child: Text(
                          controller.refreshing ? 'Checking…' : 'Try again',
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (controller.preview != null)
              _PreviewCard(controller: controller),
            if (controller.offlineNotice != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  controller.offlineNotice!,
                  key: const Key('offline-notice'),
                  style: const TextStyle(
                    color: Color(0xFF8A5300),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            if (controller.preview != null &&
                !controller.checkout &&
                controller.claimState is! ClaimConfirmed &&
                controller.preview!.state == 'claimable')
              FilledButton(
                key: const Key('continue-checkout'),
                onPressed: controller.continueToCheckout,
                child: const Text('Continue to checkout'),
              ),
            if (controller.preview != null && controller.checkout)
              Card(
                key: const Key('checkout-review'),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Review your booking',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      Text(controller.preview!.activity.title),
                      Text(
                        _formatInZone(
                          controller.preview!.activity.startsAt,
                          controller.preview!.activity.timezone,
                        ),
                      ),
                      const Text('1 spot'),
                      Text(
                        '${_formatPrice(controller.preview!.activity.priceMinorUnits, controller.preview!.activity.currency)} ${controller.preview!.activity.currency}',
                      ),
                      _IdentityCard(
                        controller: controller,
                        contactField: _contactField,
                      ),
                      if (controller.session != null)
                        _ClaimCard(controller: controller),
                    ],
                  ),
                ),
              ),
            if (controller.session != null &&
                controller.preview != null &&
                !controller.checkout &&
                (controller.claimState is ClaimConfirmed ||
                    controller.claimState is ClaimUnknown ||
                    controller.claimState is ClaimChecking))
              _ClaimCard(controller: controller),
            if (controller.session != null)
              _SavedBookingsCard(controller: controller),
          ],
        ),
      ),
    );
  }
}

class _PreviewCard extends StatelessWidget {
  const _PreviewCard({required this.controller});

  final InviteController controller;

  @override
  Widget build(BuildContext context) {
    final preview = controller.preview!;
    final activity = preview.activity;
    return Card(
      key: const Key('preview-card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(activity.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text('Invited by ${preview.inviterDisplayName}'),
            Text(activity.description),
            const Text(
              'Shared plan',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            Text(preview.plan.itinerary),
            Text('Your host: ${preview.host.displayName}'),
            Text(
              preview.host.summary.isEmpty
                  ? 'Host background coming soon.'
                  : preview.host.summary,
            ),
            if (preview.host.previousActivities.isEmpty)
              const Text('No previous activities listed.'),
            for (final previous in preview.host.previousActivities)
              Text(previous.title),
            Text(
              preview.rail == 'vouch'
                  ? 'Personal invitation — use the email that was invited'
                  : 'Public link — anyone can book while spots remain',
            ),
            const SizedBox(height: 8),
            Text(
              'Starts ${_formatInZone(activity.startsAt, activity.timezone)}',
            ),
            if (activity.endsAt != null)
              Text(
                'Ends ${_formatInZone(activity.endsAt!, activity.timezone)} · ${durationLabel(activity.startsAt, activity.endsAt!)}',
              ),
            if (activity.country != null) Text(countryName(activity.country!)),
            Text(_formatPrice(activity.priceMinorUnits, activity.currency)),
            Text(
              'Invitation expires ${_formatInZone(preview.expiresAt, activity.timezone)}',
            ),
            Text(
              '${activity.bookedCount} booked · ${activity.remainingSpots} remaining of ${activity.capacity}',
              key: const Key('availability'),
            ),
            if (controller.availabilityStale)
              const Text(
                'Availability may be out of date — reconnecting.',
                key: Key('availability-stale'),
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            if (_explanation(preview.state) != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _explanation(preview.state)!,
                  style: const TextStyle(
                    color: Color(0xFF8A5300),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String? _explanation(String state) => switch (state) {
    'expired' => 'This invitation has expired, so it cannot be claimed.',
    'full' => 'The activity is full — every spot is taken.',
    'used' => 'This personal invitation has already been used.',
    _ => null,
  };
}

class _IdentityCard extends StatelessWidget {
  const _IdentityCard({
    required this.controller,
    required this.contactField,
    this.independent = false,
  });

  final InviteController controller;
  final TextEditingController contactField;
  final bool independent;

  @override
  Widget build(BuildContext context) {
    final session = controller.session;
    return Card(
      key: const Key('identity-card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: session == null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Sign in with email',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('contact-field'),
                    controller: contactField,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(
                      labelText: 'Email',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 8),
                  if (controller.identityError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        controller.identityError!,
                        style: const TextStyle(color: Color(0xFFB3261E)),
                      ),
                    ),
                  const SizedBox(height: 8),
                  FilledButton(
                    key: const Key('select-identity'),
                    onPressed: controller.identityBusy
                        ? null
                        : () => controller.selectIdentity(
                            email: contactField.text,
                            independent: independent,
                          ),
                    child: Text(
                      controller.identityBusy ? 'Signing in…' : 'Sign in',
                    ),
                  ),
                  const Text(
                    'Your invite code stays exactly where it is while you sign in.',
                    style: TextStyle(fontSize: 12, color: Colors.black54),
                  ),
                ],
              )
            : Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Signed in as ${session.displayName}'),
                        if (session.email != null) Text(session.email!),
                        if (controller.identityBusy)
                          const Text('Restoring account access…'),
                        if (controller.identityError != null) ...[
                          Text(controller.identityError!),
                          TextButton(
                            onPressed: controller.restoreAccess,
                            child: const Text('Retry account access'),
                          ),
                        ],
                      ],
                    ),
                  ),
                  TextButton(
                    key: const Key('switch-identity'),
                    onPressed: () {
                      contactField.clear();
                      controller.signOut();
                    },
                    child: const Text('Sign out'),
                  ),
                ],
              ),
      ),
    );
  }
}

class _ClaimCard extends StatelessWidget {
  const _ClaimCard({required this.controller});

  final InviteController controller;

  @override
  Widget build(BuildContext context) {
    final phase = controller.claimState;
    if (phase is ClaimConfirmed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!context.mounted || !identical(controller.claimState, phase)) {
          return;
        }
        if (controller.consumeSuccessHaptic()) HapticFeedback.mediumImpact();
      });
    }
    final preview = controller.preview!;
    final claimable =
        preview.state == 'claimable' && preview.activity.remainingSpots > 0;
    return Card(
      key: const Key('claim-card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: switch (phase) {
          ClaimConfirmed() => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Your spot is saved — you are in the plan.',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF1B5E20),
                ),
              ),
              const SizedBox(height: 8),
              Text('Booking ${phase.booking.id}'),
              Text(
                'Saved ${DateFormat('EEE, MMM d, yyyy • h:mm a').format(DateTime.parse(phase.booking.createdAt).toLocal())}',
              ),
              const Text(
                'This is the saved record — reopening or refreshing shows it again, even if the invite is now unusable.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ],
          ),
          ClaimUnknown() => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'We could not confirm whether your claim was saved. ${phase.message}',
                style: const TextStyle(
                  color: Color(0xFF8A5300),
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              FilledButton(
                key: const Key('check-again'),
                onPressed: () => controller.checkBooking(),
                child: const Text('Check again'),
              ),
              const Text(
                'Checking looks up your saved booking before any new attempt.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ],
          ),
          ClaimChecking() => const Row(
            children: [
              CircularProgressIndicator(strokeWidth: 2),
              SizedBox(width: 12),
              Text('Checking your booking…'),
            ],
          ),
          ClaimSubmitting() => const Row(
            children: [
              CircularProgressIndicator(strokeWidth: 2),
              SizedBox(width: 12),
              Text('Claiming…'),
            ],
          ),
          ClaimRefused() => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                phase.message,
                style: const TextStyle(
                  color: Color(0xFF8A5300),
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              if (phase.reason == 'absent' ||
                  phase.reason == 'rate-limited' ||
                  phase.reason == 'failed' ||
                  phase.reason == 'invite-mismatch')
                FilledButton(
                  key: const Key('retry-claim'),
                  onPressed: !claimable ? null : () => controller.claim(),
                  child: Text(
                    claimable
                        ? 'Confirm booking again'
                        : 'Claiming is unavailable right now',
                  ),
                ),
              if (phase.reason == 'absent')
                const Text(
                  'Eligibility has been refreshed. Confirm again when you are ready.',
                  style: TextStyle(fontSize: 12, color: Colors.black54),
                ),
            ],
          ),
          ClaimIdle() =>
            claimable
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      FilledButton(
                        key: const Key('claim'),
                        onPressed:
                            controller.identityBusy ||
                                controller.identityError != null
                            ? null
                            : () => controller.claim(),
                        child: const Text('Confirm booking'),
                      ),
                      const Text(
                        'One spot is reserved only after the server saves your booking.',
                        style: TextStyle(fontSize: 12, color: Colors.black54),
                      ),
                    ],
                  )
                : Text(
                    preview.state == 'expired'
                        ? 'Claiming is closed for this plan.'
                        : 'Claiming is unavailable while the invitation is ${preview.state}.',
                    style: const TextStyle(color: Colors.black54),
                  ),
        },
      ),
    );
  }
}

class _SavedBookingsCard extends StatelessWidget {
  const _SavedBookingsCard({required this.controller});
  final InviteController controller;

  @override
  Widget build(BuildContext context) {
    final details = controller.savedDetails;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Saved bookings',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            TextButton(
              onPressed: controller.savedBusy
                  ? null
                  : controller.loadSavedBookings,
              child: const Text('Refresh saved bookings'),
            ),
            if (controller.savedBusy) const LinearProgressIndicator(),
            if (controller.savedError != null) Text(controller.savedError!),
            if (!controller.savedBusy &&
                controller.savedError == null &&
                controller.savedBookings.isEmpty)
              const Text('No saved bookings yet.'),
            for (final booking in controller.savedBookings)
              ListTile(
                key: Key('saved-booking-${booking.id}'),
                title: Text(booking.title),
                subtitle: Text(
                  _formatInZone(booking.startsAt, booking.timezone),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => controller.openSavedBooking(booking),
              ),
            if (details != null && controller.savedReceipt != null) ...[
              const Divider(),
              Text(
                details.activity.title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text('Booking ${controller.savedReceipt!.id} · 1 spot saved'),
              Text(
                _formatInZone(
                  details.activity.startsAt,
                  details.activity.timezone,
                ),
              ),
              Text(
                '${_formatPrice(details.activity.priceMinorUnits, details.activity.currency)} ${details.activity.currency}',
              ),
              Text(details.activity.description),
              const Text(
                'Shared plan',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              Text(details.plan.itinerary),
              Text('Your host: ${details.host.displayName}'),
              Text(details.host.summary),
              for (final previous in details.host.previousActivities)
                Text(previous.title),
            ],
          ],
        ),
      ),
    );
  }
}

String _formatInZone(String iso, String zone) {
  final instant = DateTime.parse(iso).toUtc();
  try {
    final location = tz.getLocation(zone);
    final local = tz.TZDateTime.from(instant, location);
    return '${DateFormat('EEE, MMM d, yyyy • h:mm a').format(local)} ($zone)';
  } catch (_) {
    return '${DateFormat('EEE, MMM d, yyyy • h:mm a').format(instant)} (UTC)';
  }
}

String durationLabel(String startsAt, String endsAt) {
  final minutes = DateTime.parse(endsAt)
      .difference(DateTime.parse(startsAt))
      .inMinutes;
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  if (hours == 0) return '$rest min';
  if (rest == 0) return hours == 1 ? '1 hour' : '$hours hours';
  return '$hours h $rest min';
}

const _countryNames = {
  'GB': 'United Kingdom',
  'IE': 'Ireland',
  'FR': 'France',
  'DE': 'Germany',
  'NL': 'Netherlands',
  'ES': 'Spain',
  'NG': 'Nigeria',
};

String countryName(String code) => _countryNames[code] ?? code;

String _formatPrice(int minorUnits, String currency) {
  final format = NumberFormat.simpleCurrency(name: currency);
  return format.format(minorUnits / math.pow(10, format.decimalDigits ?? 2));
}
