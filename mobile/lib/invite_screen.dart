import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import 'api.dart';
import 'invite_controller.dart';
import 'present.dart';

const ink = Color(0xFF101828);
const inkSoft = Color(0xFF475467);
const inkFaint = Color(0xFF8A94A6);
const green = Color(0xFF16803C);
const lime = Color(0xFFC0EE92);
const limeInk = Color(0xFF1B2E12);
const limeSoft = Color(0xFFE2F7C8);
const border = Color(0xFFE5EAE7);
const chipFill = Color(0xFFF3F5F7);
const warnInk = Color(0xFF8A5300);
const warnFill = Color(0xFFFFF4E5);

enum _Page { code, invitation, checkout, confirmation, bookings }

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
  bool _home = false;
  bool _enterCode = false;
  bool _viewActivity = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_onControllerChanged);
    _displayedCode = widget.controller.code;
    _codeField.text = _displayedCode ?? '';
    WidgetsBinding.instance.addPostFrameCallback((_) => _noteDisplayed());
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
      _home = false;
      _enterCode = false;
      _viewActivity = false;
    }
    if (widget.controller.session == null) _enterCode = false;
    WidgetsBinding.instance.addPostFrameCallback((_) => _noteDisplayed());
    setState(() {});
  }

  void _noteDisplayed() {
    if (!mounted) return;
    final page = _page;
    if (page != _Page.invitation && page != _Page.checkout) return;
    widget.controller.notePreviewDisplayed();
    widget.controller.noteAvailabilityRendered();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.controller.setForeground(state == AppLifecycleState.resumed);
  }

  _Page get _page {
    final controller = widget.controller;
    if (controller.preview != null && !_home) {
      if (controller.claimState is ClaimConfirmed && !_viewActivity) {
        return _Page.confirmation;
      }
      return controller.checkout ? _Page.checkout : _Page.invitation;
    }
    if (controller.session != null &&
        !_enterCode &&
        !controller.resolving &&
        controller.resolveError == null) {
      return _Page.bookings;
    }
    return _Page.code;
  }

  void _goHome() => setState(() {
    _home = true;
    _enterCode = false;
  });

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final page = _page;
    final VoidCallback? back = switch (page) {
      _Page.invitation => _goHome,
      _Page.checkout =>
        controller.claimState is ClaimSubmitting
            ? null
            : controller.leaveCheckout,
      _Page.code => () => setState(() => _enterCode = false),
      _ => null,
    };
    final showBack =
        page == _Page.invitation ||
        page == _Page.checkout ||
        (page == _Page.code && _enterCode);
    return Scaffold(
      backgroundColor: const Color(0xFFF9FAF9),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
        shape: const Border(bottom: BorderSide(color: border)),
        leading: showBack
            ? IconButton(
                key: const Key('back'),
                icon: const Icon(Icons.arrow_back),
                tooltip: 'Back',
                onPressed: back,
              )
            : null,
        title: const Text(
          'VELIO',
          style: TextStyle(
            fontWeight: FontWeight.w800,
            letterSpacing: 6,
            fontSize: 17,
            color: ink,
          ),
        ),
      ),
      body: SafeArea(
        child: switch (page) {
          _Page.code => _CodePage(
            controller: controller,
            codeField: _codeField,
            contactField: _contactField,
            independentSignIn: _independentSignIn,
            onToggleSignIn: () =>
                setState(() => _independentSignIn = !_independentSignIn),
            onResume: controller.preview == null
                ? null
                : () => setState(() => _home = false),
          ),
          _Page.invitation => _InvitationPage(controller: controller),
          _Page.checkout => _CheckoutPage(
            controller: controller,
            contactField: _contactField,
          ),
          _Page.confirmation => _ConfirmationPage(
            controller: controller,
            onViewBookings: _goHome,
            onViewActivity: () => setState(() => _viewActivity = true),
          ),
          _Page.bookings => _BookingsPage(
            controller: controller,
            contactField: _contactField,
            onEnterCode: () => setState(() {
              _enterCode = true;
              _home = true;
            }),
            onResume: controller.preview == null
                ? null
                : () => setState(() => _home = false),
          ),
        },
      ),
    );
  }
}

class _PageBody extends StatelessWidget {
  const _PageBody({required this.children, this.bottom});

  final List<Widget> children;
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
            children: children,
          ),
        ),
        if (bottom != null)
          Container(
            decoration: const BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: border)),
            ),
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
            child: bottom,
          ),
      ],
    );
  }
}

class _Surface extends StatelessWidget {
  const _Surface({required this.child, this.padding = 18, super.key});

  final Widget child;
  final double padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: EdgeInsets.all(padding),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: border),
      ),
      child: child,
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: warnFill,
        borderRadius: BorderRadius.circular(12),
      ),
      child: child,
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label, {this.icon});

  final String label;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: chipFill,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: inkSoft),
            const SizedBox(width: 6),
          ],
          Text(label, style: const TextStyle(fontSize: 13, color: ink)),
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar(this.name, {this.size = 32});

  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: const Color(0xFFA8AFB5),
      child: Text(
        initials(name),
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.36,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({
    required this.icon,
    required this.label,
    required this.value,
    this.valueKey,
    this.valueColor = ink,
    this.below,
  });

  final IconData icon;
  final String label;
  final String value;
  final Key? valueKey;
  final Color valueColor;
  final Widget? below;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: const BoxDecoration(
              color: chipFill,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 18, color: inkSoft),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(fontSize: 13, color: inkSoft),
                ),
                Text(
                  value,
                  key: valueKey,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: valueColor,
                  ),
                ),
                ?below,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.title, {this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w700,
              color: ink,
              letterSpacing: -0.5,
              height: 1.2,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 6),
            Text(
              subtitle!,
              style: const TextStyle(fontSize: 15, color: inkSoft),
            ),
          ],
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.children);

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: ink,
            ),
          ),
          const SizedBox(height: 6),
          ...children,
        ],
      ),
    );
  }
}

class _ResumeInvitation extends StatelessWidget {
  const _ResumeInvitation({required this.preview, required this.onResume});

  final InvitePreview preview;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) {
    return _Surface(
      padding: 4,
      child: Material(
        type: MaterialType.transparency,
        child: ListTile(
          key: const Key('resume-invitation'),
          title: Text(
            preview.activity.title,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: const Text('Your open invitation'),
          trailing: const Icon(Icons.chevron_right),
          onTap: onResume,
        ),
      ),
    );
  }
}

class _CodePage extends StatelessWidget {
  const _CodePage({
    required this.controller,
    required this.codeField,
    required this.contactField,
    required this.independentSignIn,
    required this.onToggleSignIn,
    required this.onResume,
  });

  final InviteController controller;
  final TextEditingController codeField;
  final TextEditingController contactField;
  final bool independentSignIn;
  final VoidCallback onToggleSignIn;
  final VoidCallback? onResume;

  @override
  Widget build(BuildContext context) {
    return _PageBody(
      children: [
        const _Heading(
          'Have an invite? Join the plan.',
          subtitle:
              'Enter your invitation code to see the plan and claim your spot.',
        ),
        _Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                key: const Key('code-field'),
                controller: codeField,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Invitation code',
                  hintText: 'Enter or paste your code',
                  prefixIcon: Icon(Icons.local_offer_outlined),
                  border: OutlineInputBorder(),
                ),
                onSubmitted: (value) => controller.openCode(value),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                key: const Key('open-code'),
                onPressed: controller.resolving
                    ? null
                    : () => controller.openCode(codeField.text),
                iconAlignment: IconAlignment.end,
                icon: const Icon(Icons.arrow_forward),
                label: const Text('View invitation'),
              ),
            ],
          ),
        ),
        if (controller.resolving) const LinearProgressIndicator(),
        if (controller.resolveError != null)
          _Notice(
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
        if (onResume != null &&
            controller.preview != null &&
            controller.claimState is! ClaimConfirmed)
          _ResumeInvitation(preview: controller.preview!, onResume: onResume!),
        if (controller.session == null) ...[
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Expanded(child: Divider()),
                Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Text('or', style: TextStyle(color: inkFaint)),
                ),
                Expanded(child: Divider()),
              ],
            ),
          ),
          OutlinedButton.icon(
            key: const Key('independent-sign-in'),
            onPressed: onToggleSignIn,
            icon: const Icon(Icons.person_outline),
            label: const Text('Sign in to view your bookings'),
          ),
          if (independentSignIn) ...[
            const SizedBox(height: 12),
            _IdentityCard(
              controller: controller,
              contactField: contactField,
              independent: true,
            ),
          ],
        ],
      ],
    );
  }
}

class _InvitationPage extends StatelessWidget {
  const _InvitationPage({required this.controller});

  final InviteController controller;

  @override
  Widget build(BuildContext context) {
    final preview = controller.preview!;
    final activity = preview.activity;
    final offset = zoneOffsetLabel(activity.startsAt, activity.timezone);
    final claimable =
        !controller.checkout &&
        controller.claimState is! ClaimConfirmed &&
        preview.state == 'claimable';
    return _PageBody(
      bottom: claimable
          ? FilledButton.icon(
              key: const Key('continue-checkout'),
              onPressed: controller.continueToCheckout,
              iconAlignment: IconAlignment.end,
              icon: const Icon(Icons.arrow_forward),
              label: const Text('Continue to booking'),
            )
          : null,
      children: [
        if (controller.cachedAt != null)
          _Notice(
            key: const Key('offline-banner'),
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
        Column(
          key: const Key('preview-card'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _Avatar(preview.inviterDisplayName, size: 28),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${preview.inviterDisplayName} invited you to join',
                    style: const TextStyle(color: inkSoft, fontSize: 14),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            _Heading(activity.title, subtitle: activity.description),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _Chip(
                  chipDateRange(
                    activity.startsAt,
                    activity.endsAt,
                    activity.timezone,
                  ),
                  icon: Icons.calendar_today_outlined,
                ),
                if (offset != null) _Chip(offset),
              ],
            ),
            const SizedBox(height: 16),
            _Surface(
              padding: 12,
              child: Column(
                children: [
                  _FactRow(
                    icon: Icons.sell_outlined,
                    label: 'Price',
                    value:
                        '${formatMoneyCompact(activity.priceMinorUnits, activity.currency)} per person',
                  ),
                  _FactRow(
                    icon: Icons.group_outlined,
                    label: 'Availability',
                    value:
                        '${activity.remainingSpots} of ${activity.capacity} spots left',
                    valueKey: const Key('availability'),
                    valueColor: activity.remainingSpots > 0
                        ? green
                        : const Color(0xFFB42318),
                    below: controller.availabilityStale
                        ? const Text(
                            'Availability may be out of date — reconnecting.',
                            key: Key('availability-stale'),
                            style: TextStyle(fontSize: 12, color: inkFaint),
                          )
                        : null,
                  ),
                  if (activity.endsAt != null)
                    _FactRow(
                      icon: Icons.schedule,
                      label: 'Duration',
                      value: durationLabel(activity.startsAt, activity.endsAt!),
                    ),
                  if (activity.country != null)
                    _FactRow(
                      icon: Icons.public,
                      label: 'Country',
                      value: countryName(activity.country!),
                    ),
                  _FactRow(
                    icon: Icons.person_outline,
                    label: 'Hosted by',
                    value: preview.host.displayName,
                  ),
                ],
              ),
            ),
            Text(
              preview.rail == 'vouch'
                  ? 'Personal invitation — use the email that was invited'
                  : 'Public link — anyone can book while spots remain',
              style: const TextStyle(color: inkSoft, fontSize: 13),
            ),
            Text(
              'Invitation expires ${chipDateTime(preview.expiresAt, activity.timezone)}',
              style: const TextStyle(color: inkSoft, fontSize: 13),
            ),
            if (_explanation(preview.state) != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  _explanation(preview.state)!,
                  style: const TextStyle(
                    color: warnInk,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            _Section('What we’ll do', [
              Text(
                preview.plan.itinerary,
                style: const TextStyle(color: inkSoft, height: 1.5),
              ),
            ]),
            _Section('Meet your host', [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _Avatar(preview.host.displayName, size: 44),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          preview.host.displayName,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          preview.host.summary.isEmpty
                              ? 'Host background coming soon.'
                              : preview.host.summary,
                          style: const TextStyle(color: inkSoft),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ]),
            _Section('Previous activities', [
              if (preview.host.previousActivities.isEmpty)
                const Text(
                  'No previous activities listed.',
                  style: TextStyle(color: inkSoft),
                ),
              for (final previous in preview.host.previousActivities)
                Text(previous.title),
            ]),
          ],
        ),
        if (controller.offlineNotice != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              controller.offlineNotice!,
              key: const Key('offline-notice'),
              style: const TextStyle(
                color: warnInk,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        if (controller.session != null &&
            !controller.checkout &&
            (controller.claimState is ClaimConfirmed ||
                controller.claimState is ClaimUnknown ||
                controller.claimState is ClaimChecking))
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: _ClaimCard(controller: controller),
          ),
      ],
    );
  }

  String? _explanation(String state) => switch (state) {
    'expired' => 'This invitation has expired, so it cannot be claimed.',
    'full' => 'The activity is full — every spot is taken.',
    'used' => 'This personal invitation has already been used.',
    _ => null,
  };
}

class _CheckoutPage extends StatelessWidget {
  const _CheckoutPage({required this.controller, required this.contactField});

  final InviteController controller;
  final TextEditingController contactField;

  @override
  Widget build(BuildContext context) {
    final activity = controller.preview!.activity;
    final price = formatMoneyCompact(
      activity.priceMinorUnits,
      activity.currency,
    );
    return _PageBody(
      children: [
        _Surface(
          key: const Key('checkout-review'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Confirm your spot',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                  color: ink,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                activity.title,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
              Text(
                chipDateRange(
                  activity.startsAt,
                  activity.endsAt,
                  activity.timezone,
                ),
                style: const TextStyle(color: inkSoft),
              ),
              if (activity.country != null)
                Text(
                  countryName(activity.country!),
                  style: const TextStyle(color: inkSoft),
                ),
              Text(
                '${activity.remainingSpots} of ${activity.capacity} spots left',
                style: const TextStyle(
                  color: green,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Divider(height: 28),
              Row(
                children: [
                  const Expanded(child: Text('1 spot')),
                  Text(price),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Total',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  Text(
                    price,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ],
              ),
            ],
          ),
        ),
        _IdentityCard(
          controller: controller,
          contactField: contactField,
          checkout: true,
        ),
        if (controller.session != null) _ClaimCard(controller: controller),
      ],
    );
  }
}

class _ConfirmationPage extends StatelessWidget {
  const _ConfirmationPage({
    required this.controller,
    required this.onViewBookings,
    required this.onViewActivity,
  });

  final InviteController controller;
  final VoidCallback onViewBookings;
  final VoidCallback onViewActivity;

  @override
  Widget build(BuildContext context) {
    final phase = controller.claimState as ClaimConfirmed;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!context.mounted || !identical(controller.claimState, phase)) return;
      if (controller.consumeSuccessHaptic()) HapticFeedback.mediumImpact();
    });
    final preview = controller.preview!;
    final activity = preview.activity;
    return _PageBody(
      children: [
        const SizedBox(height: 12),
        const Center(
          child: CircleAvatar(
            radius: 34,
            backgroundColor: limeSoft,
            child: Icon(Icons.check, size: 36, color: green),
          ),
        ),
        const SizedBox(height: 16),
        const Center(
          child: Text(
            'You’re going!',
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w700,
              color: ink,
            ),
          ),
        ),
        const SizedBox(height: 6),
        Center(
          child: Text(
            'Your spot is saved — you’re in the plan for ${activity.title}.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: inkSoft, fontSize: 15),
          ),
        ),
        const SizedBox(height: 20),
        _Surface(
          key: const Key('claim-card'),
          padding: 12,
          child: Column(
            children: [
              _FactRow(
                icon: Icons.person_outline,
                label: 'Hosted by',
                value: preview.host.displayName,
              ),
              _FactRow(
                icon: Icons.calendar_today_outlined,
                label: 'Date and time',
                value: chipDateRange(
                  activity.startsAt,
                  activity.endsAt,
                  activity.timezone,
                ),
              ),
              _FactRow(
                icon: Icons.sell_outlined,
                label: 'Price',
                value:
                    '${formatMoneyCompact(activity.priceMinorUnits, activity.currency)} per person',
              ),
              _FactRow(
                icon: Icons.confirmation_number_outlined,
                label: 'Booking',
                value: phase.booking.id,
                below: Text(
                  'Saved ${DateFormat('EEE, d MMM yyyy · HH:mm').format(DateTime.parse(phase.booking.createdAt).toLocal())}',
                  style: const TextStyle(fontSize: 12, color: inkFaint),
                ),
              ),
            ],
          ),
        ),
        const Text(
          'We’ll keep this in My bookings — reopening shows it again, even if the invitation is no longer usable.',
          style: TextStyle(fontSize: 13, color: inkSoft),
        ),
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('view-bookings'),
          onPressed: onViewBookings,
          child: const Text('View my bookings'),
        ),
        const SizedBox(height: 10),
        OutlinedButton(
          key: const Key('view-activity'),
          onPressed: onViewActivity,
          child: const Text('View activity'),
        ),
      ],
    );
  }
}

class _BookingsPage extends StatelessWidget {
  const _BookingsPage({
    required this.controller,
    required this.contactField,
    required this.onEnterCode,
    required this.onResume,
  });

  final InviteController controller;
  final TextEditingController contactField;
  final VoidCallback onEnterCode;
  final VoidCallback? onResume;

  @override
  Widget build(BuildContext context) {
    final details = controller.savedDetails;
    return _PageBody(
      bottom: OutlinedButton.icon(
        key: const Key('enter-code'),
        onPressed: onEnterCode,
        icon: const Icon(Icons.local_offer_outlined),
        label: const Text('Enter invitation code'),
      ),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Expanded(
              child: _Heading(
                'My bookings',
                subtitle: 'Your saved plans in one place.',
              ),
            ),
            IconButton(
              tooltip: 'Refresh saved bookings',
              onPressed: controller.savedBusy
                  ? null
                  : controller.loadSavedBookings,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        _IdentityCard(controller: controller, contactField: contactField),
        if (onResume != null &&
            controller.preview != null &&
            controller.claimState is! ClaimConfirmed)
          _ResumeInvitation(preview: controller.preview!, onResume: onResume!),
        if (controller.savedBusy) const LinearProgressIndicator(),
        if (controller.savedError != null)
          _Notice(child: Text(controller.savedError!)),
        if (!controller.savedBusy &&
            controller.savedError == null &&
            controller.savedBookings.isEmpty)
          const Text(
            'No saved bookings yet.',
            style: TextStyle(color: inkSoft),
          ),
        for (final booking in controller.savedBookings)
          _Surface(
            padding: 4,
            child: Material(
              type: MaterialType.transparency,
              child: ListTile(
                key: Key('saved-booking-${booking.id}'),
                title: Text(
                  booking.title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 17,
                  ),
                ),
                subtitle: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      _Chip(
                        chipDateTime(booking.startsAt, booking.timezone),
                        icon: Icons.calendar_today_outlined,
                      ),
                      _Chip(bookingStatus(booking.startsAt)),
                    ],
                  ),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => controller.openSavedBooking(booking),
              ),
            ),
          ),
        if (details != null && controller.savedReceipt != null)
          _Surface(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  details.activity.title,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text('Booking ${controller.savedReceipt!.id} · 1 spot saved'),
                Text(
                  chipDateRange(
                    details.activity.startsAt,
                    details.activity.endsAt,
                    details.activity.timezone,
                  ),
                ),
                Text(
                  formatMoneyCompact(
                    details.activity.priceMinorUnits,
                    details.activity.currency,
                  ),
                ),
                const SizedBox(height: 8),
                Text(details.activity.description),
                _Section('What we’ll do', [Text(details.plan.itinerary)]),
                _Section('Your host', [
                  Text(details.host.displayName),
                  Text(details.host.summary),
                  for (final previous in details.host.previousActivities)
                    Text(previous.title),
                ]),
              ],
            ),
          ),
      ],
    );
  }
}

class _IdentityCard extends StatelessWidget {
  const _IdentityCard({
    required this.controller,
    required this.contactField,
    this.independent = false,
    this.checkout = false,
  });

  final InviteController controller;
  final TextEditingController contactField;
  final bool independent;
  final bool checkout;

  @override
  Widget build(BuildContext context) {
    final session = controller.session;
    return _Surface(
      key: const Key('identity-card'),
      child: session == null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Sign in with email',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 10),
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
                if (controller.identityError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      controller.identityError!,
                      style: const TextStyle(color: Color(0xFFB3261E)),
                    ),
                  ),
                const SizedBox(height: 12),
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
                const SizedBox(height: 6),
                const Text(
                  'Your invite code stays exactly where it is while you sign in.',
                  style: TextStyle(fontSize: 12, color: inkFaint),
                ),
              ],
            )
          : Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        checkout
                            ? 'Booking as ${session.email ?? session.displayName}'
                            : 'Signed in as ${session.displayName}',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      if (!checkout && session.email != null)
                        Text(
                          session.email!,
                          style: const TextStyle(color: inkSoft),
                        ),
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
                  child: Text(checkout ? 'Change' : 'Sign out'),
                ),
              ],
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
    return _Surface(
      key: const Key('claim-card'),
      child: switch (phase) {
        ClaimConfirmed() => Text(
          'Your spot is saved — you are in the plan. Booking ${phase.booking.id}',
          style: const TextStyle(fontWeight: FontWeight.w700, color: green),
        ),
        ClaimUnknown() => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'We could not confirm whether your claim was saved. ${phase.message}',
              style: const TextStyle(
                color: warnInk,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            FilledButton(
              key: const Key('check-again'),
              onPressed: () => controller.checkBooking(),
              child: const Text('Check again'),
            ),
            const SizedBox(height: 6),
            const Text(
              'Checking looks up your saved booking before any new attempt.',
              style: TextStyle(fontSize: 12, color: inkFaint),
            ),
          ],
        ),
        ClaimChecking() => const Row(
          children: [
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 12),
            Text('Checking your booking…'),
          ],
        ),
        ClaimSubmitting() => const Row(
          children: [
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 12),
            Text('Claiming…'),
          ],
        ),
        ClaimRefused() => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              phase.message,
              style: const TextStyle(
                color: warnInk,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
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
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'Eligibility has been refreshed. Confirm again when you are ready.',
                  style: TextStyle(fontSize: 12, color: inkFaint),
                ),
              ),
          ],
        ),
        ClaimIdle() =>
          claimable
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    FilledButton(
                      key: const Key('claim'),
                      onPressed:
                          controller.identityBusy ||
                              controller.identityError != null
                          ? null
                          : () => controller.claim(),
                      child: const Text('Confirm my spot'),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'One spot is reserved only after the server saves your booking.',
                      style: TextStyle(fontSize: 12, color: inkFaint),
                    ),
                  ],
                )
              : Text(
                  preview.state == 'expired'
                      ? 'Claiming is closed for this plan.'
                      : 'Claiming is unavailable while the invitation is ${preview.state}.',
                  style: const TextStyle(color: inkSoft),
                ),
      },
    );
  }
}
