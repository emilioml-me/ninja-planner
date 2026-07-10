import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format as dateFnsFormat, formatDistanceToNow as dateFnsFDTN } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safe wrapper around date-fns `format`.
 * Returns `fallback` (default '') instead of throwing RangeError for
 * null / undefined / empty / invalid date values.
 *
 * For date-only strings ("YYYY-MM-DD") the time component "T00:00:00"
 * is appended automatically so the date is interpreted in local time,
 * not UTC midnight (which can shift the display date by one day).
 */
export function safeFormat(
  value: string | Date | null | undefined,
  fmt: string,
  fallback = '',
): string {
  if (value == null || value === '') return fallback;
  try {
    const d =
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(value + 'T00:00:00')
        : new Date(value as string | Date);
    return dateFnsFormat(d, fmt);
  } catch {
    return fallback;
  }
}

/**
 * Parses a "YYYY-MM-DD" date-only string as LOCAL midnight, not UTC midnight.
 * `new Date('2026-07-10')` parses as UTC midnight per the ISO-8601 spec, which for a user
 * behind UTC lands on the previous local calendar day — so date-fns `isToday`/`isAfter`/
 * `isBefore` checks against a bare `new Date(due_date)` can disagree by one day with checks
 * that (correctly) anchor at local time, like `due_date + 'T23:59:59'` used for overdue checks
 * elsewhere in this codebase. Use this anywhere a due_date is compared as a LOCAL calendar day.
 */
export function localDateOnly(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

/**
 * Today's date as YYYY-MM-DD in the browser's LOCAL timezone.
 * `new Date().toISOString().slice(0, 10)` (the previous pattern used for date-entry defaults)
 * is UTC, so a user west of UTC filling out a form in the evening would get tomorrow's date —
 * or, depending on the field's semantics, have their entry silently land in the wrong day/period.
 */
export function todayLocal(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Safe wrapper around date-fns `formatDistanceToNow`.
 * Returns '' instead of throwing for invalid / missing dates.
 */
export function safeFromNow(
  value: string | Date | null | undefined,
  opts?: { addSuffix?: boolean },
): string {
  if (value == null || value === '') return '';
  try {
    return dateFnsFDTN(new Date(value as string | Date), opts);
  } catch {
    return '';
  }
}
