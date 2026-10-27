import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';

/** Returns an E.164 number or null if the input is not a valid phone number. */
export function normalisePhone(raw: string | undefined | null, defaultCountry: CountryCode = 'IN'): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned || cleaned.length > 32) return null;
  const p = parsePhoneNumberFromString(cleaned, defaultCountry);
  return p && p.isValid() ? p.number : null;
}

/** Masks a phone number for exports/logs: +9198******10 */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '***';
  return e164.slice(0, 5) + '*'.repeat(e164.length - 7) + e164.slice(-2);
}
