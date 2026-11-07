import { describe, expect, test } from 'vitest';
import { formatBytes, formatClock } from '@/hooks/use-camera-recorder';
import { timeAgo } from '@/lib/utils';

describe('formatBytes', () => {
  test('bytes below one kilobyte are exact and never round up into a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('kilobytes, megabytes, gigabytes and terabytes: one decimal at most, ".0" dropped', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 ** 2)).toBe('1 MB');
    expect(formatBytes(15_151_100)).toBe('14.4 MB');                       // a typical short clip
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
    expect(formatBytes(3.7 * 1024 ** 3)).toBe('3.7 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB');
  });

  test('a value that rounds up to the next unit moves to it (never "1024 KB")', () => {
    expect(formatBytes(1024 ** 2 - 1)).toBe('1 MB');
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 GB');
    expect(formatBytes(1024 ** 2 - 60)).toBe('1023.9 KB');                 // not close enough to round up
  });

  test('the largest unit is the ceiling', () => {
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB');
  });

  test('nonsense input is shown as zero rather than NaN, Infinity or a negative size', () => {
    for (const bad of [-1, -1024, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(formatBytes(bad)).toBe('0 B');
  });
});

describe('formatClock', () => {
  test('mm:ss with leading zeros', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(999)).toBe('00:00');
    expect(formatClock(1000)).toBe('00:01');
    expect(formatClock(61_000)).toBe('01:01');
    expect(formatClock(10 * 60 * 1000)).toBe('10:00');
    expect(formatClock(75 * 60 * 1000)).toBe('75:00');                     // no hours column: the recorder stops at 10 minutes
  });

  test('negative, NaN and infinite values show 00:00', () => {
    for (const bad of [-5000, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatClock(bad)).toBe('00:00');
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  test('buckets', () => {
    expect(timeAgo(at(5_000), now)).toBe('just now');
    expect(timeAgo(at(59_000), now)).toBe('just now');
    expect(timeAgo(at(60_000), now)).toBe('1 min ago');
    expect(timeAgo(at(59 * 60_000), now)).toBe('59 min ago');
    expect(timeAgo(at(3_600_000), now)).toBe('1 h ago');
    expect(timeAgo(at(23 * 3_600_000), now)).toBe('23 h ago');
    expect(timeAgo(at(86_400_000), now)).toBe('1 d ago');
    expect(timeAgo(at(6 * 86_400_000), now)).toBe('6 d ago');
  });
  test('a timestamp in the future (clock skew) is "just now", not negative', () => {
    expect(timeAgo(new Date(now + 90_000).toISOString(), now)).toBe('just now');
  });
});
