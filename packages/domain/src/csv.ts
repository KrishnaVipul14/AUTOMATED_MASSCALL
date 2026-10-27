import Papa from 'papaparse';
import { normalisePhone } from './phone';

export const CSV_TEMPLATE = 'phone,name,consent_at,allow_sms,allow_voice,language\n+919800000001,Example Person,2026-01-15T10:00:00Z,true,true,hi\n';

export interface ColumnMapping { phone: string; consentAt: string; name?: string; allowSms?: string; allowVoice?: string; language?: string }
export const DEFAULT_MAPPING: ColumnMapping = { phone: 'phone', consentAt: 'consent_at', name: 'name', allowSms: 'allow_sms', allowVoice: 'allow_voice', language: 'language' };

/** Column names suggesting sensitive personal data. These are never imported (data minimisation). */
const SENSITIVE = /(religion|caste|ethnic|tribe|community|political|party|vote|health|disab|sexual|gender_identity|biometric)/i;

export interface ParsedContact { row: number; phoneE164: string; name?: string; consentAt: Date; allowSms: boolean; allowVoice: boolean; language?: string }
export interface RowError { row: number; field?: string; message: string }
export interface CsvParseResult {
  headerErrors: string[];
  warnings: string[];
  valid: ParsedContact[];
  errors: RowError[];
  duplicatesInFile: RowError[];
  totalRows: number;
}

export const MAX_IMPORT_ROWS = 100_000;

function parseBool(v: string | undefined, dflt: boolean): boolean | null {
  if (v === undefined || v.trim() === '') return dflt;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

/**
 * Parses and validates a contact CSV. Row numbers are 1-based spreadsheet rows (header = row 1).
 * Unmapped columns are discarded; sensitive-looking columns are reported as warnings and never stored.
 */
export function parseContactsCsv(text: string, mapping: ColumnMapping = DEFAULT_MAPPING, now = new Date()): CsvParseResult {
  const res: CsvParseResult = { headerErrors: [], warnings: [], valid: [], errors: [], duplicatesInFile: [], totalRows: 0 };
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
  const headers = parsed.meta.fields ?? [];
  for (const [key, col] of Object.entries(mapping)) {
    if (col && !headers.includes(col)) {
      if (key === 'phone' || key === 'consentAt') res.headerErrors.push(`Required column "${col}" (mapped to ${key}) not found`);
      else res.warnings.push(`Optional column "${col}" (mapped to ${key}) not found; default used`);
    }
  }
  const sensitive = headers.filter((h) => SENSITIVE.test(h));
  if (sensitive.length) res.warnings.push(`Ignored sensitive columns (not imported): ${sensitive.join(', ')}`);
  if (res.headerErrors.length) return res;
  if (parsed.data.length > MAX_IMPORT_ROWS) {
    res.headerErrors.push(`File has ${parsed.data.length} rows; maximum is ${MAX_IMPORT_ROWS}`);
    return res;
  }
  res.totalRows = parsed.data.length;
  const seen = new Map<string, number>();
  parsed.data.forEach((r, i) => {
    const row = i + 2;
    const phone = normalisePhone(r[mapping.phone]);
    if (!phone) return res.errors.push({ row, field: 'phone', message: `Invalid phone number "${(r[mapping.phone] ?? '').slice(0, 32)}"` });
    const consentRaw = r[mapping.consentAt]?.trim();
    const consentAt = consentRaw ? new Date(consentRaw) : null;
    if (!consentAt || isNaN(consentAt.getTime())) return res.errors.push({ row, field: 'consent_at', message: 'Missing or invalid consent timestamp' });
    if (consentAt > now) return res.errors.push({ row, field: 'consent_at', message: 'Consent timestamp is in the future' });
    const allowSms = parseBool(mapping.allowSms ? r[mapping.allowSms] : undefined, true);
    const allowVoice = parseBool(mapping.allowVoice ? r[mapping.allowVoice] : undefined, true);
    if (allowSms === null || allowVoice === null) return res.errors.push({ row, field: 'preferences', message: 'allow_sms/allow_voice must be true/false' });
    const prior = seen.get(phone);
    if (prior) return res.duplicatesInFile.push({ row, field: 'phone', message: `Duplicate of row ${prior}` });
    seen.set(phone, row);
    const name = mapping.name ? r[mapping.name]?.trim().slice(0, 100) || undefined : undefined;
    const language = mapping.language ? r[mapping.language]?.trim().slice(0, 10) || undefined : undefined;
    res.valid.push({ row, phoneE164: phone, name, consentAt, allowSms, allowVoice, language });
  });
  return res;
}
