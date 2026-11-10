import * as XLSX from 'xlsx';
import { normalisePhone } from './phone';

export interface RawRow {
  [column: string]: string;
}

export interface ParsedFile {
  headers: string[];
  rows: RawRow[];
  sheetNames: string[];
}

export interface Mapping {
  name: string;
  phone: string;
  waPhone: string;
  category: string;
}

export const COUNTRY_CODES = ['IN', 'US', 'GB', 'AE', 'AU', 'CA', 'MY', 'SA', 'PK', 'SG', 'LK', 'NG'] as const;

export async function parseSpreadsheet(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', raw: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
  const rows: RawRow[] = raw.map((r) => {
    const out: RawRow = {};
    for (const [k, v] of Object.entries(r)) {
      out[String(k).trim()] = String(v ?? '').trim();
    }
    return out;
  });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows, sheetNames: wb.SheetNames };
}

export function guessMapping(headers: string[]): Mapping {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (re: RegExp[], skip?: string): string => {
    for (const re2 of re) {
      const i = lower.findIndex((h, idx) => re2.test(h) && (skip ? lower[idx] !== skip.toLowerCase() : true));
      if (i >= 0) return headers[i];
    }
    return '';
  };
  const wa = find([/whatsapp/, /^wa$/, /^wa[\s_-]?number/]);
  return {
    name: find([/name/, /naam/, /contact\s*person/]),
    phone: find([/phone/, /mobile/, /contact/, /number/, /^tel/]),
    waPhone: wa,
    category: find([/category/, /group/, /tag/, /list/]),
  };
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  waPhone: string;
  category: string;
  valid: boolean;
  reason: string;
  duplicated: boolean;
  selected: boolean;
  status: 'pending' | 'opened' | 'done' | 'failed' | 'skipped';
  vars: Record<string, string>;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';

let idSeq = 0;
export const newContactId = () => `c${Date.now().toString(36)}_${(idSeq++).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

export function mapRowsToContacts(
  rows: RawRow[],
  mapping: Mapping,
  defaultCountry: string,
): Contact[] {
  const seen = new Set<string>();
  const contacts: Contact[] = [];
  for (const row of rows) {
    const name = mapping.name ? (row[mapping.name] ?? '') : '';
    const phoneRaw = mapping.phone ? (row[mapping.phone] ?? '') : '';
    const waRaw = mapping.waPhone ? (row[mapping.waPhone] ?? '') : '';
    const category = mapping.category ? (row[mapping.category] ?? '') : '';
    const parsed = normalisePhone(phoneRaw, defaultCountry);
    const parsedWa = waRaw ? normalisePhone(waRaw, defaultCountry) : { e164: null };
    const valid = Boolean(parsed.e164) && Boolean(mapping.phone);
    const vars: Record<string, string> = { name, phone: parsed.e164 ?? phoneRaw, category };
    for (const [h, v] of Object.entries(row)) {
      const slug = slugify(h);
      if (!(slug in vars)) vars[slug] = v;
    }
    vars.hello = name;
    const e164 = parsed.e164 ?? phoneRaw;
    const duplicated = Boolean(parsed.e164) && seen.has(parsed.e164!);
    if (parsed.e164) seen.add(parsed.e164);
    contacts.push({
      id: newContactId(),
      name: name || (e164 ? `Contact ${e164.slice(-4)}` : 'Unnamed'),
      phone: e164,
      waPhone: (parsedWa as { e164: string | null }).e164 ?? parsed.e164 ?? '',
      category,
      valid,
      reason: parsed.error ?? '',
      duplicated,
      selected: valid && !duplicated,
      status: 'pending',
      vars,
    });
  }
  return contacts;
}
