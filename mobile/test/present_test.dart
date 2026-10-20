import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:velio/present.dart';

void main() {
  setUpAll(tzdata.initializeTimeZones);

  test('initials take the first two letters of the first word', () {
    expect(initials('Ada Okafor'), 'AD');
    expect(initials('A'), 'A');
    expect(initials(''), '');
  });

  test('a chip date reads weekday, date and 24h time in the activity zone', () {
    expect(
      chipDateTime('2026-10-22T17:30:00Z', 'Europe/London'),
      'Thu, 22 Oct 2026 · 18:30',
    );
  });

  test('a range adds the end time and says when it lands on the next day', () {
    expect(
      chipDateRange(
        '2026-10-22T17:30:00Z',
        '2026-10-22T19:30:00Z',
        'Europe/London',
      ),
      'Thu, 22 Oct 2026 · 18:30–20:30',
    );
    expect(
      chipDateRange(
        '2026-10-22T20:30:00Z',
        '2026-10-23T00:00:00Z',
        'Europe/London',
      ),
      'Thu, 22 Oct 2026 · 21:30–01:00 (next day)',
    );
    expect(
      chipDateRange('2026-10-22T17:30:00Z', null, 'Europe/London'),
      'Thu, 22 Oct 2026 · 18:30',
    );
  });

  test('duration is derived from start and end', () {
    expect(
      durationLabel('2026-10-22T17:30:00Z', '2026-10-22T19:30:00Z'),
      '2 hours',
    );
    expect(
      durationLabel('2026-10-25T00:30:00Z', '2026-10-25T04:00:00Z'),
      '3 h 30 min',
    );
    expect(
      durationLabel('2026-10-22T17:30:00Z', '2026-10-22T18:15:00Z'),
      '45 min',
    );
    expect(
      durationLabel('2026-10-22T17:30:00Z', '2026-10-22T18:30:00Z'),
      '1 hour',
    );
  });

  test('the offset label shows only when the activity offset differs from the viewer', () {
    expect(
      zoneOffsetLabel(
        '2026-10-22T17:30:00Z',
        'Europe/London',
        viewerOffset: const Duration(hours: 1),
      ),
      isNull,
    );
    expect(
      zoneOffsetLabel(
        '2026-12-10T17:30:00Z',
        'Africa/Lagos',
        viewerOffset: Duration.zero,
      ),
      'GMT+1',
    );
    expect(
      zoneOffsetLabel(
        '2026-12-10T17:30:00Z',
        'Europe/London',
        viewerOffset: const Duration(hours: 1),
      ),
      'GMT',
    );
    expect(
      zoneOffsetLabel(
        '2026-10-22T17:30:00Z',
        'Asia/Kolkata',
        viewerOffset: Duration.zero,
      ),
      'GMT+5:30',
    );
  });

  test('compact money drops zero minor units but keeps real ones', () {
    expect(formatMoneyCompact(3500, 'GBP'), '£35');
    expect(formatMoneyCompact(1250, 'EUR'), '€12.50');
  });

  test('countries are named from the prototype list', () {
    expect(countryName('GB'), 'United Kingdom');
    expect(countryName('XX'), 'XX');
  });

  test('a booking reads Upcoming until its start, then Started', () {
    final now = DateTime.parse('2026-10-22T12:00:00Z');
    expect(bookingStatus('2026-10-22T17:30:00Z', now: now), 'Upcoming');
    expect(bookingStatus('2026-10-22T10:00:00Z', now: now), 'Started');
  });
}
