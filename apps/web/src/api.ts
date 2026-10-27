const API_BASE = ((import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

let accessToken: string | null = null;
export function setAccessToken(t: string | null) { accessToken = t; }
export function getAccessToken() { return accessToken; }

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    const r = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (r.ok) {
      const data = await r.json();
      setAccessToken(data.accessToken);
      headers.set('Authorization', `Bearer ${data.accessToken}`);
      res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, credentials: 'include' });
    }
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const err = await res.json();
      msg = Array.isArray(err.message) ? err.message.join(', ') : err.message || JSON.stringify(err);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  return (await res.text()) as unknown as T;
}
