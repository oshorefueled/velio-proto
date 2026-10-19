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

class _InviteScreenState extends State<InviteScreen> {
  final _codeField = TextEditingController();
  final _contactField = TextEditingController();
  String? _displayedCode;
  bool _hapticFiredForConfirmation = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
    _displayedCode = widget.controller.code;
    _codeField.text = _displayedCode ?? '';
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.controller.notePreviewDisplayed();
    });
  }

  @override
  void dispose() {
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
    // Post-frame: telemetry observes only displayed facts, and the success
    // haptic fires once through the platform channel at the confirmation.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.controller.notePreviewDisplayed();
      if (!_hapticFiredForConfirmation &&
          widget.controller.consumeSuccessHaptic()) {
        _hapticFiredForConfirmation = true;
        // One permitted success haptic; the SDK selects the exact impact call.
        HapticFeedback.mediumImpact();
      }
    });
    setState(() {});
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
            if (controller.preview != null)
              _PreviewCard(controller: controller),
            const SizedBox(height: 16),
            if (controller.preview != null)
              _IdentityCard(
                controller: controller,
                contactField: _contactField,
              ),
            const SizedBox(height: 16),
            if (controller.session != null && controller.preview != null)
              _ClaimCard(controller: controller),
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
            Text(_formatPrice(activity.priceMinorUnits, activity.currency)),
            Text(
              'Invitation expires ${_formatInZone(preview.expiresAt, activity.timezone)}',
            ),
            Text(
              '${activity.bookedCount} booked · ${activity.remainingSpots} remaining of ${activity.capacity}',
              key: const Key('availability'),
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
  const _IdentityCard({required this.controller, required this.contactField});

  final InviteController controller;
  final TextEditingController contactField;

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
                            contactKey: contactField.text,
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
                  Expanded(child: Text('Signed in as ${session.displayName}')),
                  TextButton(
                    key: const Key('switch-identity'),
                    onPressed: controller.signOut,
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
                        ? 'Try claiming again'
                        : 'Claiming is unavailable right now',
                  ),
                ),
              if (phase.reason == 'absent')
                const Text(
                  'A retry books again with the same request identity once eligibility is confirmed. Nothing is sent automatically.',
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
                        onPressed: () => controller.claim(),
                        child: const Text('Claim your spot'),
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

String _formatPrice(int minorUnits, String currency) {
  final format = NumberFormat.simpleCurrency(name: currency);
  return format.format(minorUnits / math.pow(10, format.decimalDigits ?? 2));
}
