import { parsePhoneNumberFromString, isValidPhoneNumber } from 'libphonenumber-js';

export function normalisePhone(raw: string | undefined | null, defaultCountry = 'IN'): { e164: string | null; error?: string } {
  const input = String(raw ?? '').trim();
  if (!input) return { e164: null, error: 'Empty value' };
  const cleaned = input.replace(/[^\d+]/g, '');
  try {
    if (cleaned.startsWith('+')) {
      if (!isValidPhoneNumber(cleaned)) return { e164: null, error: 'Not a valid phone number' };
      return { e164: parsePhoneNumberFromString(cleaned)!.number };
    }
    const p = parsePhoneNumberFromString(input, defaultCountry as never);
    if (!p || !p.isValid()) return { e164: null, error: `Not a valid ${defaultCountry} number (add country code like +91 for other countries)` };
    return { e164: p.number };
  } catch {
    return { e164: null, error: 'Cannot parse number' };
  }
}

export function isNonLocalNumber(phone: string, defaultCountry = 'IN'): boolean {
  const p = parsePhoneNumberFromString(phone);
  return p ? p.country !== defaultCountry : false;
}
