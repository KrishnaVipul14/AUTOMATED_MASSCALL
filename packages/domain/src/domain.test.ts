import { describe, it, expect } from 'vitest';
import { parseContactsCsv, CSV_TEMPLATE } from './csv';
import { normalisePhone, maskPhone } from './phone';
import { smsSegments } from './sms';
import { isWithinWindow, msUntilWindowOpens } from './window';

describe('phone', () => {
  it('normalises Indian numbers to E.164', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('')).toBeNull();
  });
  it('masks numbers', () => expect(maskPhone('+919876543210')).toBe('+9198******10'));
});

describe('contact CSV', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  it('accepts the template', () => {
    const r = parseContactsCsv(CSV_TEMPLATE, undefined, now);
    expect(r.headerErrors).toEqual([]);
    expect(r.valid).toHaveLength(1);
  });
  it('reports missing required columns', () => {
    const r = parseContactsCsv('name,phone\nA,9876543210\n', undefined, now);
    expect(r.headerErrors[0]).toMatch(/consent_at/);
  });
  it('reports row-level errors with spreadsheet row numbers and detects duplicates', () => {
    const csv = [
      'phone,consent_at,allow_sms',
      '9876543210,2026-01-01,true', // row 2 ok
      'not-a-phone,2026-01-01,true', // row 3 bad phone
      '9876543211,,true', // row 4 missing consent
      '+91 98765 43210,2026-01-01,true', // row 5 duplicate of row 2
      '9876543212,2030-01-01,true', // row 6 future consent
      '9876543213,2026-01-01,maybe', // row 7 bad bool
    ].join('\n');
    const r = parseContactsCsv(csv, undefined, now);
    expect(r.totalRows).toBe(6);
    expect(r.valid.map((v) => v.row)).toEqual([2]);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 6, 7]);
    expect(r.duplicatesInFile).toEqual([{ row: 5, field: 'phone', message: 'Duplicate of row 2' }]);
  });
  it('supports custom column mapping and ignores sensitive columns', () => {
    const csv = 'Mobile,Consent Date,Religion\n9876543210,2026-01-01,x\n';
    const r = parseContactsCsv(csv, { phone: 'Mobile', consentAt: 'Consent Date' }, now);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).not.toHaveProperty('Religion');
    expect(r.warnings.join()).toMatch(/Religion/);
  });
});

describe('sms segments', () => {
  it('counts GSM-7', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
    expect(smsSegments('€').units).toBe(2);
  });
  it('switches to UCS-2 for Hindi', () => {
    expect(smsSegments('नमस्ते')).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(smsSegments('न'.repeat(71)).segments).toBe(2);
  });
});

describe('operating window', () => {
  const w = { timezone: 'Asia/Kolkata', startHour: 9, endHour: 21 };
  it('evaluates hours in the configured timezone', () => {
    expect(isWithinWindow(new Date('2026-10-27T05:00:00Z'), w)).toBe(true); // 10:30 IST
    expect(isWithinWindow(new Date('2026-10-27T16:00:00Z'), w)).toBe(false); // 21:30 IST
  });
  it('computes delay until window opens', () => {
    expect(msUntilWindowOpens(new Date('2026-10-27T05:00:00Z'), w)).toBe(0);
    expect(msUntilWindowOpens(new Date('2026-10-27T03:00:00Z'), w)).toBe(30 * 60_000); // 08:30 -> 09:00 IST
  });
});
