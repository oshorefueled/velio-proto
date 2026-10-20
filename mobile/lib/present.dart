import 'dart:math' as math;

import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

String initials(String displayName) {
  final words = displayName.trim().split(RegExp(r'\s+'));
  final word = words.isEmpty ? '' : words.first;
  return (word.length > 2 ? word.substring(0, 2) : word).toUpperCase();
}

DateTime _inZone(String iso, String zone) {
  final instant = DateTime.parse(iso).toUtc();
  try {
    return tz.TZDateTime.from(instant, tz.getLocation(zone));
  } catch (_) {
    return instant;
  }
}

String chipDateTime(String iso, String zone) =>
    DateFormat("EEE, dd MMM yyyy '·' HH:mm").format(_inZone(iso, zone));

String chipDateRange(String startsAt, String? endsAt, String zone) {
  final head = chipDateTime(startsAt, zone);
  if (endsAt == null) return head;
  final start = _inZone(startsAt, zone);
  final end = _inZone(endsAt, zone);
  final days = DateTime.utc(
    end.year,
    end.month,
    end.day,
  ).difference(DateTime.utc(start.year, start.month, start.day)).inDays;
  final later = days == 0
      ? ''
      : days == 1
      ? ' (next day)'
      : ' (+$days days)';
  return '$head–${DateFormat('HH:mm').format(end)}$later';
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

String _offsetName(Duration offset) {
  if (offset == Duration.zero) return 'GMT';
  final sign = offset.isNegative ? '-' : '+';
  final minutes = offset.inMinutes.abs();
  final rest = minutes % 60;
  return 'GMT$sign${minutes ~/ 60}${rest == 0 ? '' : ':${rest.toString().padLeft(2, '0')}'}';
}

String? zoneOffsetLabel(String iso, String zone, {Duration? viewerOffset}) {
  final instant = DateTime.parse(iso).toUtc();
  final Duration activity;
  try {
    activity = tz.TZDateTime.from(instant, tz.getLocation(zone)).timeZoneOffset;
  } catch (_) {
    return null;
  }
  final viewer = viewerOffset ?? instant.toLocal().timeZoneOffset;
  return activity == viewer ? null : _offsetName(activity);
}

String formatMoneyCompact(int minorUnits, String currency) {
  final digits = NumberFormat.simpleCurrency(name: currency).decimalDigits ?? 2;
  final whole = minorUnits % math.pow(10, digits).toInt() == 0;
  return NumberFormat.simpleCurrency(
    locale: 'en_GB',
    name: currency,
    decimalDigits: whole ? 0 : digits,
  ).format(minorUnits / math.pow(10, digits));
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

String bookingStatus(String startsAt, {DateTime? now}) =>
    DateTime.parse(startsAt).isAfter(now ?? DateTime.now())
    ? 'Upcoming'
    : 'Started';
