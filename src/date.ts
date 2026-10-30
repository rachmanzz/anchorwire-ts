/**
 * Date and timestamp conversion utilities for AnchorDB.
 *
 * In AnchorDB, dates are represented as IEEE 754 float32 numbers
 * indicating "Epoch Days" (number of integer days elapsed since 1970-01-01 UTC).
 * Timestamps are represented as float32 Unix epoch seconds.
 */

const MS_PER_DAY = 86400000;

/**
 * Parses an ISO "YYYY-MM-DD" date string into numeric Epoch Days (days since 1970-01-01 UTC).
 * Throws an Error if the format is malformed or invalid.
 */
export function parseDate(dateStr: string): number {
  const trimmed = dateStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`invalid date format "${dateStr}": expected YYYY-MM-DD`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`invalid date values in "${dateStr}"`);
  }

  const utcMs = Date.UTC(year, month - 1, day);
  const checkDate = new Date(utcMs);
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day
  ) {
    throw new Error(`calendar overflow in date "${dateStr}"`);
  }

  return Math.floor(utcMs / MS_PER_DAY);
}

/**
 * Parses an ISO "YYYY-MM-DD" date string into numeric Epoch Days.
 * Throws an Error on failure (convenient alias matching Go driver.MustDate).
 */
export function mustDate(dateStr: string): number {
  return parseDate(dateStr);
}

/**
 * Formats numeric Epoch Days back to an ISO "YYYY-MM-DD" date string.
 * Rounds to nearest integer day before converting.
 */
export function formatDate(epochDays: number): string {
  const roundedDays = Math.round(epochDays);
  const ms = roundedDays * MS_PER_DAY;
  const d = new Date(ms);

  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  // Handle years with sign or padding
  const yStr = y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : String(y);
  return `${yStr}-${m}-${day}`;
}

/**
 * Parses a "YYYY-MM-DD HH:MM:SS" or ISO-8601 RFC3339 string into Unix timestamp seconds.
 */
export function parseTimestamp(tsStr: string): number {
  const trimmed = tsStr.trim();
  const spaceMatch = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (spaceMatch) {
    const year = Number.parseInt(spaceMatch[1], 10);
    const month = Number.parseInt(spaceMatch[2], 10);
    const day = Number.parseInt(spaceMatch[3], 10);
    const hour = Number.parseInt(spaceMatch[4], 10);
    const min = Number.parseInt(spaceMatch[5], 10);
    const sec = Number.parseInt(spaceMatch[6], 10);
    return Math.floor(Date.UTC(year, month - 1, day, hour, min, sec) / 1000);
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid timestamp string: "${tsStr}"`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Formats Unix timestamp seconds back into a "YYYY-MM-DD HH:MM:SS" UTC string.
 */
export function formatTimestamp(unixSec: number): string {
  const d = new Date(Math.round(unixSec) * 1000);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hour}:${min}:${sec}`;
}
