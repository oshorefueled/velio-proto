import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'live_availability.dart';

/// Typed transport for the Velio backend (docs/client-contract.md). One place
/// owns the base URL, error envelope and Retry-After plumbing so every caller
/// speaks the machine-readable contract. The transport is injectable (tests
/// pass fakes); production uses dart:io over the configured base URL
/// (emulator/LAN base documented in mobile/README.md).
typedef Transport = Future<TransportResponse> Function(
  String method,
  String path, {
  String? body,
  String? token,
});

class TransportResponse {
  const TransportResponse({
    required this.status,
    required this.json,
    this.headers = const {},
  });
  final int status;
  final Object? json;
  final Map<String, String> headers;
}

class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, {this.retryAfterSeconds});
  final int status;
  final String code;
  final String message;
  final int? retryAfterSeconds;
  bool get isSessionError =>
      status == 401 ||
      code == 'session_required' ||
      code == 'session_invalid' ||
      code == 'session_expired';
  @override
  String toString() => message;
}

int? _retryAfterFrom(Map<String, String> headers) {
  final raw = headers['retry-after'];
  if (raw == null || raw.isEmpty) return null;
  return int.tryParse(raw.trim());
}

/// Public invite preview (docs/client-contract.md §4): never a target contact.
class InvitePreview {
  const InvitePreview({
    required this.code,
    required this.rail,
    required this.generation,
    required this.state,
    required this.expiresAt,
    required this.inviterDisplayName,
    required this.activity,
    required this.plan,
    required this.host,
    this.source,
  });
  final String code;
  final String rail;
  final int generation;
  final String state;
  final String expiresAt;
  final String inviterDisplayName;
  final InviteActivity activity;
  final InvitePlan plan;
  final InviteHost host;

  /// The decoded response this preview came from; the offline cache keeps it.
  final Map<String, dynamic>? source;

  InvitePreview withState(String state) => InvitePreview(
    code: code,
    rail: rail,
    generation: generation,
    state: state,
    expiresAt: expiresAt,
    inviterDisplayName: inviterDisplayName,
    activity: activity,
    plan: plan,
    host: host,
    source: source,
  );

  /// Newer committed counts; a claimable invitation with no spots left reads
  /// as full, so the explanation and controls never contradict the count.
  InvitePreview withActivity(InviteActivity activity) => InvitePreview(
    code: code,
    rail: rail,
    generation: generation,
    state: state == 'claimable' && activity.remainingSpots <= 0
        ? 'full'
        : state,
    expiresAt: expiresAt,
    inviterDisplayName: inviterDisplayName,
    activity: activity,
    plan: plan,
    host: host,
    source: source,
  );

  factory InvitePreview.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    final invite = (map['invite'] as Map).cast<String, dynamic>();
    return InvitePreview(
      code: invite['code'] as String,
      rail: invite['rail'] as String,
      generation: (invite['generation'] as num).toInt(),
      state: invite['state'] as String,
      expiresAt: invite['expiresAt'] as String,
      inviterDisplayName: invite['inviterDisplayName'] as String,
      activity: InviteActivity.fromJson(invite['activity']),
      plan: InvitePlan.fromJson(invite['plan']),
      host: InviteHost.fromJson(invite['host']),
      source: map,
    );
  }
}

class InvitePlan {
  const InvitePlan({
    required this.id,
    required this.activityId,
    required this.itinerary,
  });
  final String id;
  final String activityId;
  final String itinerary;
  factory InvitePlan.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return InvitePlan(
      id: map['id'] as String,
      activityId: map['activityId'] as String,
      itinerary: map['itinerary'] as String,
    );
  }
}

class PreviousActivity {
  const PreviousActivity({
    required this.id,
    required this.title,
    required this.startsAt,
  });
  final String id;
  final String title;
  final String startsAt;
  factory PreviousActivity.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return PreviousActivity(
      id: map['id'] as String,
      title: map['title'] as String,
      startsAt: map['startsAt'] as String,
    );
  }
}

class InviteHost {
  const InviteHost({
    required this.id,
    required this.displayName,
    required this.summary,
    required this.previousActivities,
  });
  final String id;
  final String displayName;
  final String summary;
  final List<PreviousActivity> previousActivities;
  factory InviteHost.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return InviteHost(
      id: map['id'] as String,
      displayName: map['displayName'] as String,
      summary: map['summary'] as String,
      previousActivities: (map['previousActivities'] as List)
          .map(PreviousActivity.fromJson)
          .toList(),
    );
  }
}

class InviteActivity {
  const InviteActivity({
    required this.id,
    required this.title,
    required this.description,
    required this.startsAt,
    this.endsAt,
    required this.timezone,
    this.country,
    required this.priceMinorUnits,
    required this.currency,
    required this.capacity,
    required this.bookedCount,
    required this.remainingSpots,
    required this.availabilityVersion,
  });
  final String id;
  final String title;
  final String description;
  final String startsAt;
  final String? endsAt;
  final String timezone;
  final String? country;
  final int priceMinorUnits;
  final String currency;
  final int capacity;
  final int bookedCount;
  final int remainingSpots;
  final String availabilityVersion;

  /// Committed availability from the live owner; booked count follows capacity.
  InviteActivity withAvailability({
    required String version,
    required int remainingSpots,
  }) => InviteActivity(
    id: id,
    title: title,
    description: description,
    startsAt: startsAt,
    endsAt: endsAt,
    timezone: timezone,
    country: country,
    priceMinorUnits: priceMinorUnits,
    currency: currency,
    capacity: capacity,
    bookedCount: capacity - remainingSpots < 0 ? 0 : capacity - remainingSpots,
    remainingSpots: remainingSpots,
    availabilityVersion: version,
  );

  factory InviteActivity.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return InviteActivity(
      id: map['id'] as String,
      title: map['title'] as String,
      description: map['description'] as String,
      startsAt: map['startsAt'] as String,
      endsAt: map['endsAt'] as String?,
      timezone: map['timezone'] as String,
      country: map['country'] as String?,
      priceMinorUnits: (map['priceMinorUnits'] as num).toInt(),
      currency: map['currency'] as String,
      capacity: (map['capacity'] as num).toInt(),
      bookedCount: (map['bookedCount'] as num).toInt(),
      remainingSpots: (map['remainingSpots'] as num).toInt(),
      availabilityVersion: map['availabilityVersion'] as String,
    );
  }
}

class UserSnapshot {
  const UserSnapshot({
    required this.id,
    required this.displayName,
    required this.email,
  });
  final String id;
  final String displayName;
  final String email;

  factory UserSnapshot.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return UserSnapshot(
      id: map['id'] as String,
      displayName: map['displayName'] as String,
      email: map['email'] as String,
    );
  }
}

class SessionEstablishment {
  const SessionEstablishment({
    required this.token,
    required this.expiresAt,
    required this.user,
    required this.created,
  });
  final String token;
  final String expiresAt;
  final UserSnapshot user;
  final bool created;

  factory SessionEstablishment.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    final session = (map['session'] as Map).cast<String, dynamic>();
    return SessionEstablishment(
      token: session['token'] as String,
      expiresAt: session['expiresAt'] as String,
      user: UserSnapshot.fromJson(map['user']),
      created: map['created'] as bool,
    );
  }
}

/// Saved booking receipt exactly as docs/client-contract.md documents it.
class BookingView {
  const BookingView({
    required this.id,
    required this.activityId,
    required this.planId,
    required this.userId,
    required this.createdAt,
    required this.rail,
    required this.generation,
  });
  final String id;
  final String activityId;
  final String planId;
  final String userId;
  final String createdAt;
  final String rail;
  final int generation;

  factory BookingView.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    final attribution = (map['attribution'] as Map).cast<String, dynamic>();
    return BookingView(
      id: map['id'] as String,
      activityId: map['activityId'] as String,
      planId: map['planId'] as String,
      userId: map['userId'] as String,
      createdAt: map['createdAt'] as String,
      rail: attribution['rail'] as String,
      generation: (attribution['generation'] as num).toInt(),
    );
  }
}

class SavedBookingSummary {
  const SavedBookingSummary({
    required this.id,
    required this.activityId,
    required this.planId,
    required this.title,
    required this.startsAt,
    required this.timezone,
  });
  final String id;
  final String activityId;
  final String planId;
  final String title;
  final String startsAt;
  final String timezone;
  factory SavedBookingSummary.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    final activity = (map['activity'] as Map).cast<String, dynamic>();
    return SavedBookingSummary(
      id: map['id'] as String,
      activityId: map['activityId'] as String,
      planId: map['planId'] as String,
      title: activity['title'] as String,
      startsAt: activity['startsAt'] as String,
      timezone: activity['timezone'] as String,
    );
  }
}

class ActivityDetails {
  const ActivityDetails({
    required this.activity,
    required this.plan,
    required this.host,
  });
  final InviteActivity activity;
  final InvitePlan plan;
  final InviteHost host;
  factory ActivityDetails.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return ActivityDetails(
      activity: InviteActivity.fromJson(map['activity']),
      plan: InvitePlan.fromJson(map['plan']),
      host: InviteHost.fromJson(map['host']),
    );
  }
}

class BookingOperationResult {
  const BookingOperationResult({required this.booking, required this.created});
  final BookingView booking;
  final bool created;

  factory BookingOperationResult.fromJson(Object? json) {
    final map = (json as Map).cast<String, dynamic>();
    return BookingOperationResult(
      booking: BookingView.fromJson(map['booking']),
      created: map['created'] as bool,
    );
  }
}

class VelioApi {
  factory VelioApi({required String baseUrl, Transport? transport}) {
    return VelioApi._(baseUrl, transport ?? VelioApi.ioTransport(baseUrl));
  }

  VelioApi._(this.baseUrl, this.transport);

  /// The production dart:io transport for the given base URL; also the
  /// delegation point for callers that observe traffic around it.
  static Transport ioTransport(String baseUrl) =>
      (method, path, {body, token}) =>
          _defaultTransport(baseUrl, method, path, body: body, token: token);

  static Future<TransportResponse> _defaultTransport(
    String baseUrl,
    String method,
    String path, {
    String? body,
    String? token,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, Uri.parse('$baseUrl$path'));
      // Headers must be complete before the body starts streaming: writing
      // first would freeze them and fail every authenticated request.
      if (token != null) request.headers.set('authorization', 'Bearer $token');
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(body);
      }
      final response = await request.close().timeout(
        const Duration(seconds: 15),
      );
      final text = await response.transform(utf8.decoder).join();
      final parsed = text.isEmpty ? null : jsonDecode(text);
      return TransportResponse(
        status: response.statusCode,
        json: parsed,
        headers: {'retry-after': response.headers.value('retry-after') ?? ''},
      );
    } finally {
      client.close(force: true);
    }
  }

  final String baseUrl;
  final Transport transport;

  Future<Object?> _send(
    String method,
    String path, {
    Object? body,
    String? token,
  }) async {
    final response = await transport(
      method,
      path,
      body: body == null ? null : jsonEncode(body),
      token: token,
    );
    final json = response.json;
    if (json is Map && json['error'] is Map) {
      final error = (json['error'] as Map).cast<String, dynamic>();
      throw ApiError(
        response.status,
        (error['code'] as String?) ?? 'server_error',
        (error['message'] as String?) ?? 'Request failed',
        retryAfterSeconds: response.status == 429
            ? _retryAfterFrom(response.headers)
            : null,
      );
    }
    if (response.status >= 400) {
      throw ApiError(
        response.status,
        'server_error',
        'Request failed with ${response.status}',
      );
    }
    return json;
  }

  Future<InvitePreview> resolveInvite(String code) async {
    final json = await _send('GET', '/invites/${Uri.encodeComponent(code)}');
    return InvitePreview.fromJson(json);
  }

  Future<SessionEstablishment> establishSession({
    required String email,
    String? displayName,
    String? inviteCode,
    required String visitorId,
    String? visitId,
  }) async {
    final json = await _send(
      'POST',
      '/demo/sessions',
      body: {
        'email': email,
        if (displayName != null && displayName.isNotEmpty)
          'displayName': displayName,
        'inviteCode': ?inviteCode,
        'visitorId': visitorId,
        'visitId': ?visitId,
        'channel': 'flutter',
      },
    );
    return SessionEstablishment.fromJson(json);
  }

  /// Credential validation (GET /demo/me): the saved session is still valid.
  Future<UserSnapshot> me(String token) async {
    final json = await _send('GET', '/demo/me', token: token);
    return UserSnapshot.fromJson((json as Map)['user']);
  }

  /// Lost-response recovery lookup; 404 booking_not_found is a definitive
  /// absence (an ApiError), never a fabricated empty result.
  Future<BookingView> getMyBooking(String token, String activityId) async {
    final json = await _send(
      'GET',
      '/activities/$activityId/bookings/me',
      token: token,
    );
    return BookingView.fromJson((json as Map)['booking']);
  }

  Future<List<SavedBookingSummary>> getMyBookings(String token) async {
    final json = await _send('GET', '/my/bookings', token: token);
    return ((json as Map)['bookings'] as List)
        .map(SavedBookingSummary.fromJson)
        .toList();
  }

  Future<ActivityDetails> getActivity(String activityId) async =>
      ActivityDetails.fromJson(await _send('GET', '/activities/$activityId'));

  Future<BookingOperationResult> bookActivity(
    String token,
    String activityId,
    String operationId, {
    String? inviteCode,
  }) async {
    final json = await _send(
      'POST',
      '/activities/$activityId/bookings',
      token: token,
      body: {'operationId': operationId, 'inviteCode': ?inviteCode},
    );
    return BookingOperationResult.fromJson(json);
  }

  /// Rendered-availability measurement (SPEC C5): never affects the view.
  Future<void> postAvailabilityAck(AvailabilityAck ack) async {
    await _send(
      'POST',
      '/availability-acks',
      body: {
        'connectionId': ack.connectionId,
        'activityId': ack.activityId,
        'appliedVersion': ack.appliedVersion,
        'appliedEventId': ?ack.appliedEventId,
        'source': ack.source,
        'reason': ack.reason,
      },
    );
  }

  /// Observability only (docs/client-contract.md §5): never vetoes identity
  /// or claim. channel:flutter with the persistent visitor id.
  Future<void> emitEvent({
    required String type,
    required String eventId,
    required String visitorId,
    Map<String, Object?> properties = const {},
    String? token,
    String? visitId,
  }) async {
    await _send(
      'POST',
      '/client-events',
      body: {
        'type': type,
        'eventId': eventId,
        'visitorId': visitorId,
        'visitId': ?visitId,
        'channel': 'flutter',
        ...properties,
      },
      token: token,
    );
  }
}
