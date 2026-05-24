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
