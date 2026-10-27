import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from './api';
import { useAuth } from './auth-context';

const Card = ({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) => (
  <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 shadow-sm">
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
      {right}
    </div>
    {children}
  </section>
);

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
    <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
    <div className="text-2xl font-bold mt-1">{value}</div>
    {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
  </div>
);

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('admin@demo.local');
  const [password, setPassword] = useState('Demo-Password-2026!');
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await login(email, password, mfaCode || undefined);
      if (r.mfaRequired) setNeedsMfa(true);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-600">Internal Operational Platform</div>
          <h1 className="text-xl font-bold mt-0.5">Sign in to CommHub</h1>
          <p className="text-xs text-slate-500 mt-1">Authorised political &amp; public-service communication management. No unsolicited or commercial use.</p>
        </div>
        {err && <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">{err}</div>}
        <div>
          <label htmlFor="email" className="block text-xs font-medium mb-1">Official Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm" />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-medium mb-1">Password</label>
          <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm" />
        </div>
        {needsMfa && (
          <div>
            <label htmlFor="mfa" className="block text-xs font-medium mb-1">6-digit Authenticator Code</label>
            <input id="mfa" inputMode="numeric" pattern="\d{6}" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} className="w-full px-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm" />
          </div>
        )}
        <button disabled={busy} type="submit" className="w-full py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
        <div className="text-[11px] text-slate-500 border-t border-slate-200 dark:border-slate-800 pt-3">
          Demo accounts (password <code className="font-mono">Demo-Password-2026!</code>): <code className="font-mono">admin@demo.local</code>, <code className="font-mono">operator@demo.local</code>, <code className="font-mono">approver@demo.local</code>, <code className="font-mono">auditor@demo.local</code>
        </div>
      </form>
    </div>
  );
}

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => api<{
      mode: string;
      emergencyStop: boolean;
      contacts: { total: number; eligible: number; suppressionRecords: number };
      campaignsByStatus: Record<string, number>;
      pendingOutboxJobs: number;
      outcomes: Record<string, { real: number; simulated: number }>;
      recentActivity: { id: string; action: string; entityType: string; actorEmail?: string; createdAt: string }[];
      providers: { configs: { channel: string; adapter: string; enabled: boolean; mode: string; approvalVerified: boolean }[]; errorsLast24h: number };
      usage: { channel: string; currency: string; isEstimate: boolean; amount: string; quantity: number }[];
    }>('/dashboard/summary'),
  });
  if (isLoading || !data) return <div className="text-sm text-slate-500">Loading dashboard…</div>;

  const outcomeRows = Object.entries(data.outcomes).map(([status, v]) => ({ status, simulated: v.simulated, real: v.real }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Operational Overview</h1>
        <p className="text-xs text-slate-500">Authoritative figures from PostgreSQL. Simulated outcomes are explicitly separated from real provider-reported outcomes.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Total Contact Records" value={data.contacts.total} sub="Stored in PostgreSQL" />
        <Stat label="Eligible Contacts" value={data.contacts.eligible} sub="Excluding suppressed numbers" />
        <Stat label="Suppression / Opt-out Records" value={data.contacts.suppressionRecords} sub="Enforced pre-execution" />
        <Stat label="Pending Outbox Jobs" value={data.pendingOutboxJobs} sub={`Provider errors (24h): ${data.providers.errorsLast24h}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Campaigns by Status">
          <div className="grid grid-cols-3 gap-2 text-xs">
            {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PROCESSING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'].map((s) => (
              <div key={s} className="p-2.5 rounded bg-slate-50 dark:bg-slate-800 flex justify-between">
                <span className="text-slate-600 dark:text-slate-300">{s}</span>
                <span className="font-bold">{data.campaignsByStatus[s] ?? 0}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Provider-Reported &amp; Simulated Outcomes (Answered ≠ Heard)">
          {outcomeRows.length === 0 ? (
            <div className="text-xs text-slate-500 py-6 text-center">No recipient operations recorded yet.</div>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={outcomeRows}>
                  <XAxis dataKey="status" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="simulated" name="Simulated (Mock)" fill="#f59e0b" />
                  <Bar dataKey="real" name="Provider-Reported" fill="#4f46e5" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Provider Health &amp; Approval Status">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="py-1.5">Channel</th><th>Adapter</th><th>Mode</th><th>Use-Case Approved</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.configs.map((p) => (
                <tr key={`${p.channel}-${p.adapter}`} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="py-2 font-medium">{p.channel}</td>
                  <td>{p.adapter}</td>
                  <td><span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">{p.mode}</span></td>
                  <td>{p.approvalVerified ? 'Verified' : 'Not verified'}</td>
                  <td>{p.enabled ? 'Enabled' : 'Disabled'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Internal Operational Usage Summary (Not Customer Billing)">
          {data.usage.length === 0 ? (
            <div className="text-xs text-slate-500 py-4">No usage recorded yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-1.5">Channel</th><th>Type</th><th>Units</th><th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.map((u, i) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">{u.channel}</td>
                    <td>{u.isEstimate ? 'Estimated (Simulated)' : 'Provider-Reported Charge'}</td>
                    <td>{u.quantity}</td>
                    <td>{u.currency} {Number(u.amount).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Recent Administrative &amp; Operational Activity">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
          {data.recentActivity.map((a) => (
            <li key={a.id} className="py-2 flex justify-between">
              <span><strong className="font-semibold">{a.action}</strong> on {a.entityType} by {a.actorEmail ?? 'system'}</span>
              <span className="text-slate-400">{new Date(a.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function ContactsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [supFilter, setSupFilter] = useState<'all' | 'only' | 'exclude'>('all');
  const [source, setSource] = useState('BOOTH_SURVEY');
  const [lawfulBasis, setLawfulBasis] = useState('Signed consent form');
  const [preview, setPreview] = useState<{
    id: string; totalRows: number; validRows: number; invalidRows: number; duplicateRows: number; suppressedRows: number;
    errors: { row: number; field?: string; message: string }[]; warnings?: string[];
  } | null>(null);
  const [supPhone, setSupPhone] = useState('');
  const [supReason, setSupReason] = useState('Recipient opt-out');
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['contacts', q, supFilter],
    queryFn: () => api<{
      items: { id: string; phoneE164: string; name?: string; source: string; lawfulBasis: string; consentAt: string; allowSms: boolean; allowVoice: boolean; suppressed: boolean }[];
      total: number;
    }>(`/contacts?q=${encodeURIComponent(q)}&suppressed=${supFilter}`),
  });

  const suppressions = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api<{ id: string; phoneE164: string; reason: string; source: string; createdAt: string }[]>('/contacts/suppressions'),
  });

  const handlePreview = async (file: File) => {
    setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', source);
    fd.append('lawfulBasis', lawfulBasis);
    try {
      const r = await api<typeof preview>('/contacts/imports/preview', { method: 'POST', body: fd });
      setPreview(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed');
    }
  };

  const commitMut = useMutation({
    mutationFn: (id: string) => api(`/contacts/imports/${id}/commit`, { method: 'POST' }),
    onSuccess: () => {
      setPreview(null);
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });

  const suppressMut = useMutation({
    mutationFn: () => api('/contacts/suppressions', { method: 'POST', body: JSON.stringify({ phone: supPhone, reason: supReason, source: 'MANUAL' }) }),
    onSuccess: () => {
      setSupPhone('');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/contacts/${id}?reason=Deletion%20request`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Contact &amp; Suppression Management</h1>
          <p className="text-xs text-slate-500">Every contact requires a documented source and lawful basis. Sensitive personal attributes are rejected on import.</p>
        </div>
        <a
          href="/api/contacts/template.csv"
          onClick={async (e) => {
            e.preventDefault();
            const csv = await api<string>('/contacts/template.csv');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'contacts-template.csv'; a.click();
          }}
          className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-medium"
        >
          Download CSV Template
        </a>
      </div>

      {err && <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">{err}</div>}

      {can('contacts:import') && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Import Contacts from CSV (Preview &amp; Validate First)">
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Contact Source</label>
                  <input value={source} onChange={(e) => setSource(e.target.value)} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                </div>
                <div>
                  <label className="block font-medium mb-1">Lawful Basis / Permission</label>
                  <input value={lawfulBasis} onChange={(e) => setLawfulBasis(e.target.value)} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                </div>
              </div>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => e.target.files?.[0] && void handlePreview(e.target.files[0])}
                className="block w-full text-xs"
              />
              {preview && (
                <div className="p-3 rounded bg-slate-50 dark:bg-slate-800 space-y-2 border border-slate-200 dark:border-slate-700">
                  <div className="font-semibold">
                    Preview: {preview.validRows} importable / {preview.totalRows} total rows · {preview.invalidRows} invalid · {preview.duplicateRows} duplicates · {preview.suppressedRows} suppressed
                  </div>
                  {preview.warnings?.map((w, i) => <div key={i} className="text-amber-700">Warning: {w}</div>)}
                  {preview.errors.length > 0 && (
                    <ul className="max-h-28 overflow-y-auto text-[11px] text-red-600 space-y-0.5">
                      {preview.errors.slice(0, 20).map((er, i) => <li key={i}>Row {er.row}: {er.message}</li>)}
                    </ul>
                  )}
                  <button
                    onClick={() => commitMut.mutate(preview.id)}
                    disabled={preview.validRows === 0 || commitMut.isPending}
                    className="px-3 py-1.5 rounded bg-indigo-600 text-white font-semibold disabled:opacity-50"
                  >
                    Commit {preview.validRows} Valid Contacts
                  </button>
                </div>
              )}
            </div>
          </Card>

          <Card title="Add Suppression / Opt-Out Record">
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="+919876543210" value={supPhone} onChange={(e) => setSupPhone(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                <input placeholder="Reason" value={supReason} onChange={(e) => setSupReason(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
              </div>
              <button onClick={() => suppressMut.mutate()} disabled={!supPhone} className="px-3 py-1.5 rounded bg-red-600 text-white font-semibold disabled:opacity-50">
                Suppress Number Immediately
              </button>
              <div className="pt-2 text-slate-500">Recent suppressions ({suppressions.data?.length ?? 0}):</div>
              <ul className="max-h-24 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {suppressions.data?.slice(0, 8).map((s) => (
                  <li key={s.id} className="py-1 flex justify-between">
                    <span className="font-mono">{s.phoneE164}</span>
                    <span>{s.reason} ({s.source})</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </div>
      )}

      <Card
        title={`Contact Records (${list.data?.total ?? 0})`}
        right={
          <div className="flex gap-2 text-xs">
            <input placeholder="Search phone or name…" value={q} onChange={(e) => setQ(e.target.value)} className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
            <select value={supFilter} onChange={(e) => setSupFilter(e.target.value as 'all' | 'only' | 'exclude')} className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent">
              <option value="all">All</option>
              <option value="exclude">Eligible Only</option>
              <option value="only">Suppressed Only</option>
            </select>
          </div>
        }
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Phone (E.164)</th><th>Name</th><th>Source &amp; Lawful Basis</th><th>Consent Timestamp</th><th>Prefs</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-mono">{c.phoneE164}</td>
                <td>{c.name ?? '—'}</td>
                <td>{c.source} · <span className="text-slate-500">{c.lawfulBasis}</span></td>
                <td>{new Date(c.consentAt).toLocaleDateString()}</td>
                <td>{c.allowSms ? 'SMS ' : ''}{c.allowVoice ? 'Voice' : ''}</td>
                <td>
                  {c.suppressed ? (
                    <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 font-semibold">SUPPRESSED</span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">ELIGIBLE</span>
                  )}
                </td>
                <td className="text-right">
                  {can('contacts:suppress') && (
                    <button
                      onClick={() => window.confirm(`Delete ${c.phoneE164} and add to suppression list?`) && deleteMut.mutate(c.id)}
                      className="text-red-600 hover:underline"
                    >
                      Delete &amp; Suppress
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function VoicePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['voice-announcements'],
    queryFn: () => api<{ id: string; title: string; filename: string; sizeBytes: number; durationSec: number; status: string; createdAt: string }[]>('/voice-announcements'),
  });

  const upload = async (file: File) => {
    setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', title || file.name);
    try {
      await api('/voice-announcements', { method: 'POST', body: fd });
      setTitle('');
      qc.invalidateQueries({ queryKey: ['voice-announcements'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    }
  };

  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api(`/voice-announcements/${id}/review`, { method: 'POST', body: JSON.stringify({ decision }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-announcements'] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Recorded Voice Announcements</h1>
        <p className="text-xs text-slate-500">WAV/MP3/OGG up to 10 MB and 180 seconds. Must be approved before a campaign using it can be submitted.</p>
      </div>
      {err && <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">{err}</div>}
      {can('campaigns:create') && (
        <Card title="Upload Recording">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <input placeholder="Announcement title" value={title} onChange={(e) => setTitle(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
            <input type="file" accept="audio/wav,audio/mpeg,audio/ogg" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </div>
        </Card>
      )}
      <Card title="Stored Recordings">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Title</th><th>File</th><th>Duration</th><th>Size</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-medium">{a.title}</td>
                <td>{a.filename}</td>
                <td>{a.durationSec}s</td>
                <td>{(a.sizeBytes / 1024).toFixed(1)} KB</td>
                <td><span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-semibold">{a.status}</span></td>
                <td className="space-x-2">
                  {can('campaigns:approve') && a.status !== 'APPROVED' && (
                    <>
                      <button onClick={() => review.mutate({ id: a.id, decision: 'APPROVED' })} className="text-emerald-600 font-semibold">Approve</button>
                      <button onClick={() => review.mutate({ id: a.id, decision: 'REJECTED' })} className="text-red-600">Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function SmsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const list = useQuery({
    queryKey: ['sms-templates'],
    queryFn: () => api<{ id: string; name: string; body: string; segments: number; encoding: string; status: string }[]>('/sms-templates'),
  });
  const est = useQuery({
    queryKey: ['sms-est', body],
    queryFn: () => api<{ encoding: string; units: number; segments: number; perSegment: number }>('/sms-templates/estimate', { method: 'POST', body: JSON.stringify({ body }) }),
  });
  const create = useMutation({
    mutationFn: () => api('/sms-templates', { method: 'POST', body: JSON.stringify({ name, body }) }),
    onSuccess: () => { setName(''); setBody(''); qc.invalidateQueries({ queryKey: ['sms-templates'] }); },
  });
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api(`/sms-templates/${id}/review`, { method: 'POST', body: JSON.stringify({ decision }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sms-templates'] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">SMS Message Templates</h1>
        <p className="text-xs text-slate-500">Compose permitted SMS announcements with live encoding and segment estimation.</p>
      </div>
      {can('campaigns:create') && (
        <Card title="Compose SMS Template">
          <div className="space-y-3 text-xs">
            <input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
            <textarea rows={3} placeholder="Message text (include opt-out instructions)" value={body} onChange={(e) => setBody(e.target.value)} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
            <div className="flex items-center justify-between text-slate-500">
              <span>Encoding: <strong>{est.data?.encoding ?? 'GSM-7'}</strong> · Units: <strong>{est.data?.units ?? 0}</strong> · Estimated segments: <strong>{est.data?.segments ?? 0}</strong></span>
              <button onClick={() => create.mutate()} disabled={!name || !body} className="px-3 py-1.5 rounded bg-indigo-600 text-white font-semibold disabled:opacity-50">
                Save Template for Review
              </button>
            </div>
          </div>
        </Card>
      )}
      <Card title="Templates">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Name</th><th>Preview</th><th>Encoding / Segments</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-medium">{t.name}</td>
                <td className="max-w-md truncate">{t.body}</td>
                <td>{t.encoding} · {t.segments} seg</td>
                <td><span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-semibold">{t.status}</span></td>
                <td className="space-x-2">
                  {can('campaigns:approve') && t.status !== 'APPROVED' && (
                    <>
                      <button onClick={() => review.mutate({ id: t.id, decision: 'APPROVED' })} className="text-emerald-600 font-semibold">Approve</button>
                      <button onClick={() => review.mutate({ id: t.id, decision: 'REJECTED' })} className="text-red-600">Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function CampaignsPage({ onlyPending = false }: { onlyPending?: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'SMS' | 'VOICE'>('SMS');
  const [smsTemplateId, setSmsTemplateId] = useState('');
  const [audioAssetId, setAudioAssetId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{
      id: string; name: string; channel: 'SMS' | 'VOICE'; status: string; simulated: boolean;
      scheduledAt?: string; createdAt: string; outcomes: Record<string, number>;
    }[]>('/campaigns'),
  });
  const sms = useQuery({ queryKey: ['sms-templates'], queryFn: () => api<{ id: string; name: string; status: string }[]>('/sms-templates') });
  const voice = useQuery({ queryKey: ['voice-announcements'], queryFn: () => api<{ id: string; title: string; status: string }[]>('/voice-announcements') });

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setErr(null);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const create = async () => {
    setErr(null);
    try {
      await api('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name, channel,
          smsTemplateId: channel === 'SMS' ? smsTemplateId : undefined,
          audioAssetId: channel === 'VOICE' ? audioAssetId : undefined,
          audience: {},
        }),
      });
      setName('');
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create campaign');
    }
  };

  const rows = (campaigns.data ?? []).filter((c) => (!onlyPending ? true : c.status === 'PENDING_APPROVAL'));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{onlyPending ? 'Approval Queue' : 'Campaign Lifecycle Management'}</h1>
        <p className="text-xs text-slate-500">Explicit maker-checker approval is enforced server-side. The campaign creator cannot approve their own campaign.</p>
      </div>
      {err && <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">{err}</div>}

      {!onlyPending && can('campaigns:create') && (
        <Card title="Create Campaign Draft">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
            <input placeholder="Campaign name" value={name} onChange={(e) => setName(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
            <select value={channel} onChange={(e) => setChannel(e.target.value as 'SMS' | 'VOICE')} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent">
              <option value="SMS">SMS</option>
              <option value="VOICE">Recorded Voice</option>
            </select>
            {channel === 'SMS' ? (
              <select value={smsTemplateId} onChange={(e) => setSmsTemplateId(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent">
                <option value="">Select approved SMS template…</option>
                {sms.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.status})</option>)}
              </select>
            ) : (
              <select value={audioAssetId} onChange={(e) => setAudioAssetId(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent">
                <option value="">Select approved voice recording…</option>
                {voice.data?.map((a) => <option key={a.id} value={a.id}>{a.title} ({a.status})</option>)}
              </select>
            )}
            <button onClick={() => void create()} disabled={!name} className="px-3 py-1.5 rounded bg-indigo-600 text-white font-semibold disabled:opacity-50">
              Create Draft
            </button>
          </div>
        </Card>
      )}

      <Card title={`Campaigns (${rows.length})`}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Name</th><th>Channel</th><th>Status</th><th>Mode</th><th>Outcomes</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-medium">{c.name}</td>
                <td>{c.channel}</td>
                <td><span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-semibold">{c.status}</span></td>
                <td>{c.simulated ? 'SIMULATED' : 'PRODUCTION'}</td>
                <td className="font-mono text-[11px]">
                  {Object.entries(c.outcomes).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}
                </td>
                <td className="space-x-2">
                  {c.status === 'DRAFT' && can('campaigns:create') && (
                    <button onClick={() => void act(`/campaigns/${c.id}/submit`)} className="text-indigo-600 font-semibold">Submit for Approval</button>
                  )}
                  {c.status === 'PENDING_APPROVAL' && can('campaigns:approve') && (
                    <>
                      <button onClick={() => void act(`/campaigns/${c.id}/approve`, { note: 'Approved' })} className="text-emerald-600 font-semibold">Approve</button>
                      <button onClick={() => { const r = window.prompt('Rejection reason:'); if (r) void act(`/campaigns/${c.id}/reject`, { reason: r }); }} className="text-red-600">Reject</button>
                    </>
                  )}
                  {c.status === 'APPROVED' && can('campaigns:control') && (
                    <button onClick={() => void act(`/campaigns/${c.id}/schedule`, {})} className="text-indigo-600 font-semibold">Schedule Now</button>
                  )}
                  {(c.status === 'SCHEDULED' || c.status === 'PROCESSING') && can('campaigns:control') && (
                    <button onClick={() => void act(`/campaigns/${c.id}/pause`, { reason: 'Operator pause' })} className="text-amber-600 font-semibold">Pause</button>
                  )}
                  {c.status === 'PAUSED' && can('campaigns:control') && (
                    <button onClick={() => void act(`/campaigns/${c.id}/resume`)} className="text-emerald-600 font-semibold">Resume</button>
                  )}
                  {(c.status === 'PROCESSING' || c.status === 'COMPLETED' || c.status === 'SCHEDULED') && can('campaigns:control') && (
                    <button onClick={() => void act(`/webhooks/simulate/campaign/${c.id}`)} className="text-indigo-600">Simulate Callbacks</button>
                  )}
                  {!['COMPLETED', 'CANCELLED', 'FAILED'].includes(c.status) && can('campaigns:control') && (
                    <button onClick={() => window.confirm('Cancel this campaign?') && void act(`/campaigns/${c.id}/cancel`, { reason: 'Cancelled' })} className="text-red-600">Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function SchedulerPage() {
  const q = useQuery({
    queryKey: ['queues-health'],
    queryFn: () => api<{
      redisOk: boolean;
      queues: Record<string, { counts: Record<string, number>; failed: { id?: string; name: string; failedReason: string; attemptsMade: number }[] }>;
      outbox: { pending: number; failed: number };
      recentJobs: { id: string; queue: string; name: string; refId?: string; status: string; attempts: number; createdAt: string }[];
    }>('/queues/health'),
    refetchInterval: 4000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Scheduler &amp; BullMQ Queue Monitor</h1>
        <p className="text-xs text-slate-500">PostgreSQL holds authoritative campaign &amp; outbox state; Redis/BullMQ holds transient queue state processed by the separate worker process.</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Redis Connection" value={q.data?.redisOk ? 'Connected' : 'Unreachable'} />
        <Stat label="Outbox Pending" value={q.data?.outbox.pending ?? 0} />
        <Stat label="Outbox Failed" value={q.data?.outbox.failed ?? 0} />
      </div>
      <Card title="Queues">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Completed</th><th>Failed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(q.data?.queues ?? {}).map(([name, info]) => (
              <tr key={name} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-mono">{name}</td>
                <td>{info.counts.waiting ?? 0}</td>
                <td>{info.counts.active ?? 0}</td>
                <td>{info.counts.delayed ?? 0}</td>
                <td>{info.counts.completed ?? 0}</td>
                <td className="text-red-600 font-semibold">{info.counts.failed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Recent Durable Job Records (PostgreSQL)">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-1.5">Queue</th><th>Job</th><th>Ref</th><th>Status</th><th>Attempts</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.recentJobs.map((j) => (
              <tr key={j.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-1.5 font-mono">{j.queue}</td>
                <td>{j.name}</td>
                <td className="font-mono text-[11px]">{j.refId ?? '—'}</td>
                <td>{j.status}</td>
                <td>{j.attempts}</td>
                <td>{new Date(j.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function ReportsPage() {
  const { can } = useAuth();
  const rep = useQuery({
    queryKey: ['reports-outcomes'],
    queryFn: () => api<{
      mode: string; note: string;
      counts: Record<string, { real: number; simulated: number }>;
      costSummary: { estimatedInr: string; providerReportedInr: string };
    }>('/reports/outcomes'),
  });

  const exportCsv = async () => {
    const csv = await api<string>('/reports/export.csv');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'outcomes-report.csv';
    a.click();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Reports, Delivery Outcomes &amp; Internal Usage</h1>
          <p className="text-xs text-slate-500">{rep.data?.note}</p>
        </div>
        {can('reports:export') && (
          <button onClick={() => void exportCsv()} className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs font-semibold">
            Export Authorised CSV (Masked)
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Estimated Usage Cost (INR)" value={`₹${rep.data?.costSummary.estimatedInr ?? '0.00'}`} sub="Internal operational estimate" />
        <Stat label="Provider-Reported Charges (INR)" value={`₹${rep.data?.costSummary.providerReportedInr ?? '0.00'}`} sub="Reconciled from provider callbacks" />
      </div>
      <Card title="Outcome Breakdown (Simulated vs Real Provider-Reported)">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Normalised Status</th><th>Simulated (Mock Mode)</th><th>Real Provider-Reported</th><th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['SUBMITTED', 'Request sent to provider adapter'],
              ['PROVIDER_ACCEPTED', 'Accepted by provider queue (not yet delivered/answered)'],
              ['ANSWERED', 'Voice call connected (does NOT mean announcement was heard)'],
              ['COMPLETED', 'Voice announcement playback completed'],
              ['DELIVERED', 'SMS delivery receipt reported by provider'],
              ['FAILED', 'Rejected or delivery failed'],
              ['UNCERTAIN', 'Timeout/ambiguous response; awaiting reconciliation — never blindly retried'],
              ['SKIPPED_SUPPRESSED', 'Blocked by pre-execution suppression or preference recheck'],
              ['CANCELLED', 'Cancelled before provider submission'],
            ].map(([st, desc]) => (
              <tr key={st} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-mono font-semibold">{st}</td>
                <td>{rep.data?.counts[st]?.simulated ?? 0}</td>
                <td>{rep.data?.counts[st]?.real ?? 0}</td>
                <td className="text-slate-500">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function AuditPage() {
  const q = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => api<{ items: { id: string; actorEmail?: string; action: string; entityType: string; entityId?: string; createdAt: string }[]; total: number }>('/audit-logs'),
  });
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Immutable Audit Logs ({q.data?.total ?? 0})</h1>
      <Card title="Audit Trail">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Timestamp (UTC)</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-1.5 font-mono">{new Date(a.createdAt).toISOString()}</td>
                <td>{a.actorEmail ?? 'system'}</td>
                <td className="font-semibold">{a.action}</td>
                <td>{a.entityType}</td>
                <td className="font-mono text-[11px]">{a.entityId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function TeamPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('OPERATOR');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ id: string; email: string; name: string; role: string; active: boolean; mfaEnabled: boolean }[]>('/users'),
  });

  const create = async () => {
    setErr(null);
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({ email, name, role, password }) });
      setEmail(''); setName(''); setPassword('');
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Team &amp; Role-Based Permissions</h1>
      {err && <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">{err}</div>}
      <Card title="Create Staff Account (Administrator Only)">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 text-xs">
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
          <input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent">
            <option value="OPERATOR">OPERATOR</option>
            <option value="APPROVER">APPROVER</option>
            <option value="AUDITOR">AUDITOR</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <input type="password" placeholder="Password (min 12 chars)" value={password} onChange={(e) => setPassword(e.target.value)} className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
          <button onClick={() => void create()} className="px-3 py-1.5 rounded bg-indigo-600 text-white font-semibold">Add User</button>
        </div>
      </Card>
      <Card title="Staff Accounts">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Name</th><th>Email</th><th>Role</th><th>MFA</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-medium">{u.name}</td>
                <td>{u.email}</td>
                <td><span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 font-semibold">{u.role}</span></td>
                <td>{u.mfaEnabled ? 'Enabled' : 'Optional'}</td>
                <td>{u.active ? 'Active' : 'Disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function ProvidersPage() {
  const q = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{
      envMode: string;
      credentials: { voiceApiKeyConfigured: boolean; smsApiKeyConfigured: boolean; webhookSecretConfigured: boolean };
      productionBlockers: { VOICE: string[]; SMS: string[] };
      configs: { id: string; channel: string; adapter: string; enabled: boolean; mode: string; ratePerSecond: number; maxConcurrency: number; approvalVerified: boolean }[];
    }>('/providers'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Provider Configuration (Administrator Only)</h1>
        <p className="text-xs text-slate-500">API secrets are read only from server-side environment variables and are never exposed to the browser.</p>
      </div>
      <Card title="Server-Side Credential Status (Values Never Exposed)">
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div>Voice API Key: <strong>{q.data?.credentials.voiceApiKeyConfigured ? 'Configured' : 'Not configured (Mock active)'}</strong></div>
          <div>SMS API Key: <strong>{q.data?.credentials.smsApiKeyConfigured ? 'Configured' : 'Not configured (Mock active)'}</strong></div>
          <div>Webhook Signing Secret: <strong>{q.data?.credentials.webhookSecretConfigured ? 'Configured' : 'Not configured'}</strong></div>
        </div>
      </Card>
      <Card title="Production Readiness Gates (Why Real Sending Is Currently Blocked)">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <div className="font-semibold mb-1">VOICE Blockers:</div>
            <ul className="list-disc pl-4 space-y-0.5 text-amber-800 dark:text-amber-300">
              {q.data?.productionBlockers.VOICE.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
          <div>
            <div className="font-semibold mb-1">SMS Blockers:</div>
            <ul className="list-disc pl-4 space-y-0.5 text-amber-800 dark:text-amber-300">
              {q.data?.productionBlockers.SMS.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        </div>
      </Card>
      <Card title="Configured Adapters">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Channel</th><th>Adapter</th><th>Mode</th><th>Rate Limit</th><th>Max Concurrency</th><th>Use-Case Approval</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.configs.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-2 font-semibold">{c.channel}</td>
                <td>{c.adapter}</td>
                <td>{c.mode}</td>
                <td>{c.ratePerSecond}/sec</td>
                <td>{c.maxConcurrency}</td>
                <td>{c.approvalVerified ? 'Verified' : 'Unverified'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{
      mode: string; timezone: string;
      operatingWindow: { timezone: string; startHour: number; endHour: number; enforceInMockMode?: boolean };
      complianceItems: { key: string; label: string; checked: boolean; checkedAt?: string }[];
    }>('/settings'),
  });

  const toggle = useMutation({
    mutationFn: ({ key, checked }: { key: string; checked: boolean }) =>
      api(`/settings/compliance/${key}`, { method: 'PATCH', body: JSON.stringify({ checked }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Compliance Checklist &amp; Operating Window</h1>
        <p className="text-xs text-slate-500">
          This checklist helps responsible staff track operational prerequisites. Completing it does not by itself constitute legal compliance; verify TRAI/DLT, election-commission rules, privacy law, and written provider approval before any production deployment.
        </p>
      </div>
      <Card title="Pre-Production Compliance Checklist">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
          {q.data?.complianceItems.map((item) => (
            <li key={item.key} className="py-2.5 flex items-center justify-between gap-3">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled={!can('settings:manage')}
                  onChange={(e) => toggle.mutate({ key: item.key, checked: e.target.checked })}
                />
                <span>{item.label}</span>
              </label>
              <span className="text-slate-400">{item.checked ? 'Verified' : 'Pending'}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Permitted Operating Window">
        <div className="text-xs">
          Timezone: <strong>{q.data?.operatingWindow.timezone}</strong> · Permitted hours: <strong>{q.data?.operatingWindow.startHour}:00 – {q.data?.operatingWindow.endHour}:00</strong>
        </div>
      </Card>
    </div>
  );
}
