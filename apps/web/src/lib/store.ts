import type { Contact, Mapping } from './contacts';

const KEY = 'campaign-sender:v1';

export interface CampaignData {
  mapping: Mapping;
  country: string;
  contacts: Contact[];
  campaignName: string;
  message: string;
  method: string;
  consentConfirmed: boolean;
}

export function saveData(data: CampaignData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    return;
  }
}

export function loadData(): CampaignData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CampaignData;
    if (!parsed || !Array.isArray(parsed.contacts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearData() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    return;
  }
}

export function exportResultsCsv(campaignName: string, contacts: Contact[], method: string) {
  const lines = ['Name,Phone,Status'];
  for (const c of contacts) {
    const escape = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    lines.push([escape(c.name), escape(c.phone), escape(c.status)].join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(campaignName || 'campaign').replace(/[^a-zA-Z0-9_-]+/g, '_')}-results-${method}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
