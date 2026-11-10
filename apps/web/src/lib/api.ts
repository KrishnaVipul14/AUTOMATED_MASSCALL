export const API_BASE = (
  (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? 'https://commhub-api.onrender.com'
).replace(/\/$/, '');

let token: string | null = null;

async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 401) {
    token = null;
    throw new Error('Not authorised. Re-check the API connection and try again.');
  }
  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try {
      const err = await res.json();
      msg = Array.isArray(err.message) ? err.message.join(', ') : err.message || msg;
    } catch {
      // plain-text error body
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : ((await res.text()) as unknown as T);
}

export interface ConnectionState {
  ok: boolean;
  reason?: string;
  providerConfigured?: boolean;
  providerName?: string;
}

/**
 * The backend API is the only place where automated voice calls can be started
 * (a browser cannot dial PSTN numbers). This checks whether the API is running
 * and reports honestly if no telephony provider (e.g. Twilio) is configured.
 */
export async function checkVoiceConnection(): Promise<ConnectionState> {
  let reachable = false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/auto-token`, { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.accessToken) token = data.accessToken;
      reachable = true;
    }
  } catch {
    return { ok: false, reason: 'Campaign API is not reachable. Automated voice campaigns need the API running and a telephony provider configured.' };
  }
  if (!reachable) {
    return { ok: false, reason: 'Campaign API replied with an error. Automated voice campaigns are not available right now.' };
  }
  try {
    const summary = await request<{ providers?: { configs?: { channel: string; adapter: string; enabled: boolean }[] } }>('/dashboard/summary');
    const voiceConfig = (summary.providers?.configs ?? []).find((p) => p.channel === 'VOICE');
    const isMock = voiceConfig ? voiceConfig.adapter === 'mock' : true;
    return { ok: true, providerConfigured: Boolean(voiceConfig && voiceConfig.enabled && !isMock), providerName: voiceConfig?.adapter ?? 'none' };
  } catch {
    return { ok: true, providerConfigured: false, providerName: 'unknown' };
  }
}

export async function uploadAudio(file: File, title: string): Promise<{ id: string; title: string; durationSec: number | null }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', title || file.name);
  const asset = await request<{ id: string; title: string; durationSec: number | null }>('/voice-announcements', { method: 'POST', body: fd });
  return asset;
}

/** Asks the API to place automated calls. The API refuses honestly (no provider configured) rather than faking success. */
export async function startVoiceCampaign(payload: { phones: string[]; names: string[]; audioAssetId: string; campaignName: string }) {
  const lines = payload.names.map((n, i) => `${n || 'Recipient'},${payload.phones[i]}`);
  return request<{ success: true; campaignId: string; campaignName: string; dispatchedCalls: number; suppressedSkipped: number; status: string; voiceNote: { title: string }; message: string }>(
    '/campaigns/quick-call',
    { method: 'POST', body: JSON.stringify({ sqlOrData: lines.join('\n'), campaignName: payload.campaignName, audioAssetId: payload.audioAssetId, autoSimulate: false }) },
  );
}
