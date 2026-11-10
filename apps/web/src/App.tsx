import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Mapping, Contact, ParsedFile } from './lib/contacts';
import { COUNTRY_CODES, guessMapping, mapRowsToContacts, parseSpreadsheet } from './lib/contacts';
import { fillTemplate, templateKeys, whatsappLink, telLink } from './lib/message';
import { API_BASE, checkVoiceConnection, ConnectionState, startVoiceCampaign, uploadAudio } from './lib/api';
import { clearData, exportResultsCsv, loadData, saveData } from './lib/store';

type Method = 'whatsapp' | 'call' | 'voice';

const btn = 'px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-slate-900 text-white hover:bg-slate-700`;
const btnGhost = `${btn} border border-slate-300 hover:bg-slate-100`;
const input = 'w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

function Panel({ title, children, step }: { title: string; children: React.ReactNode; step: number }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Step {step}</div>
      <h2 className="text-lg font-bold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function StatusChip({ status }: { status: Contact['status'] }) {
  const classes: Record<Contact['status'], string> = {
    pending: 'bg-slate-100 text-slate-600',
    opened: 'bg-amber-100 text-amber-800',
    done: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-red-100 text-red-700',
    skipped: 'bg-slate-200 text-slate-500',
  };
  const labels: Record<Contact['status'], string> = {
    pending: 'Pending', opened: 'Opened - confirm result', done: 'Done', failed: 'Failed', skipped: 'Skipped',
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${classes[status]}`}>{labels[status]}</span>;
}

/* ---------------- Step 1: Contacts ---------------- */

function ContactsStep({ parsed, setParsed, mapping, setMapping, country, setCountry, contacts, addContacts, onChangeContact, removeContact, removeInvalid, onNext }: {
  parsed: ParsedFile | null;
  setParsed: (f: ParsedFile | null) => void;
  mapping: Mapping;
  setMapping: (m: Mapping) => void;
  country: string;
  setCountry: (c: string) => void;
  contacts: Contact[];
  addContacts: () => void;
  onChangeContact: (id: string, patch: Partial<Contact>) => void;
  removeContact: (id: string) => void;
  removeInvalid: () => void;
  onNext: () => void;
}) {
  const [filter, setFilter] = useState<'valid' | 'all' | 'invalid' | 'dup'>('valid');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    setParseError(null);
    setBusy(true);
    try {
      const data = await parseSpreadsheet(file);
      setMapping(guessMapping(data.headers));
      setParsed(data);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Could not read file');
      setParsed(null);
    } finally {
      setBusy(false);
    }
  };

  const validCount = contacts.filter((c) => c.valid && !c.duplicated).length;
  const shown = contacts.filter((c) =>
    filter === 'all' ? true : filter === 'valid' ? c.valid && !c.duplicated : filter === 'invalid' ? !c.valid : c.duplicated,
  );

  return (
    <Panel title="Upload Contacts" step={1}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button className={btnGhost} onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Reading file…' : contacts.length ? 'Add CSV / Excel file' : 'Choose CSV or Excel file'}
        </button>
        <input
          ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" className="hidden"
          onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
        />
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Country for numbers without +code
          <select value={country} onChange={(e) => setCountry(e.target.value)} className="px-2 py-2 rounded-md border border-slate-300 text-sm">
            {COUNTRY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {parseError && <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{parseError}</div>}

      {parsed && (
        <div className="mt-4 space-y-3">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm">
            {parsed.rows.length} rows and {parsed.headers.length} columns found. Match your columns below.
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([['name', 'Name (optional)'], ['phone', 'Phone number (required)'], ['waPhone', 'WhatsApp number (optional)'], ['category', 'Category (optional)']] as const).map(
              ([field, label]) => (
                <label key={field} className="text-xs">
                  <span className="block mb-1 text-slate-600">{label}</span>
                  <select value={mapping[field]} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })} className={input}>
                    <option value="">- none -</option>
                    {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ),
            )}
          </div>
          <div className="overflow-x-auto max-h-40 border border-slate-200 rounded-md">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-100">{parsed.headers.map((h) => <th key={h} className="px-2 py-1 text-left font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {parsed.rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">{parsed.headers.map((h) => <td key={h} className="px-2 py-1 whitespace-nowrap">{r[h]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className={btnPrimary} disabled={!mapping.phone} onClick={addContacts}>
            {mapping.phone ? `Import ${parsed.rows.length} rows` : 'Choose the Phone Number column first'}
          </button>
        </div>
      )}

      {contacts.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{validCount}</span><span className="text-slate-500">ready contacts ·</span>
            <span>{contacts.filter((c) => c.duplicated).length} duplicates</span>·
            <span>{contacts.filter((c) => !c.valid).length} invalid</span>
            <div className="flex gap-1 ml-auto">
              {(['valid', 'all', 'invalid', 'dup'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-2.5 py-1 rounded text-xs ${filter === f ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200'}`}>
                  {f === 'valid' ? 'Ready' : f === 'all' ? 'All' : f === 'invalid' ? 'Invalid' : 'Duplicates'}
                </button>
              ))}
              <button onClick={removeInvalid} className="px-2.5 py-1 rounded text-xs bg-slate-100 hover:bg-slate-200">Remove invalid</button>
            </div>
          </div>
          <div className="mt-2 max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {shown.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input type="checkbox" checked={c.selected} disabled={!c.valid || c.duplicated}
                  onChange={(e) => onChangeContact(c.id, { selected: e.target.checked })} />
                <span className="w-40 truncate font-medium">{c.name}</span>
                <span className="font-mono text-xs">{c.phone || '-'}</span>
                {c.waPhone && c.waPhone !== c.phone && <span title="Separate WhatsApp number" className="text-emerald-600 text-xs">WA: {c.waPhone}</span>}
                {c.category && <span className="text-xs text-slate-500">{c.category}</span>}
                {c.duplicated && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs">Duplicate</span>}
                {!c.valid && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">{c.reason}</span>}
                <button onClick={() => removeContact(c.id)} title="Remove" className="ml-auto text-slate-400 hover:text-red-600 text-xs">Remove</button>
              </div>
            ))}
            {shown.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">No contacts in this view.</div>}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mt-4">
        <span className="text-xs text-slate-500">{validCount ? `${validCount} ready contacts selected` : 'Import a file with phone numbers to continue'}</span>
        <button onClick={onNext} disabled={!validCount} className={btnPrimary + ' text-sm'}>Continue</button>
      </div>
    </Panel>
  );
}

/* ---------------- Step 2: Compose ---------------- */

function ComposeStep({ contacts, campaignName, setCampaignName, message, setMessage, method, setMethod, consent, setConsent, onBack, onNext }: {
  contacts: Contact[];
  campaignName: string; setCampaignName: (v: string) => void;
  message: string; setMessage: (v: string) => void;
  method: Method; setMethod: (m: Method) => void;
  consent: boolean; setConsent: (v: boolean) => void;
  onBack: () => void; onNext: () => void;
}) {
  const first = contacts.find((c) => c.selected && c.valid && !c.duplicated);
  const preview = first ? fillTemplate(message, first) : '';
  const keys = templateKeys(contacts);
  const hasPlaceholder = message.includes('{{');

  const methods: { id: Method; label: string; desc: string }[] = [
    { id: 'whatsapp', label: 'WhatsApp message', desc: 'Opens each WhatsApp chat with your message pre-filled. You press send yourself.' },
    { id: 'call', label: 'Direct phone call', desc: 'Opens your phone dialer (tel: link) for each contact. You place the call yourself.' },
    { id: 'voice', label: 'Prerecorded voice campaign', desc: 'Automated calls playing your recording. Needs a telephony provider - the app checks and tells you honestly if none is connected.' },
  ];

  return (
    <Panel title="Message and Method" step={2}>
      <div className="space-y-4 text-sm">
        <div>
          <span className="block mb-1 text-slate-600 text-xs">Campaign name</span>
          <input className={input} value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. Diwali greeting October 2026" />
        </div>
        <div>
          <span className="block mb-2 text-slate-600 text-xs">Communication method</span>
          <div className="grid gap-2 md:grid-cols-3">
            {methods.map((m) => (
              <button key={m.id} onClick={() => setMethod(m.id)}
                className={`text-left p-3 rounded-lg border text-xs transition-colors ${method === m.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 hover:bg-slate-50'}`}>
                <div className="font-semibold">{m.label}</div>
                <div className={`mt-1 ${method === m.id ? 'text-slate-300' : 'text-slate-500'}`}>{m.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex flex-wrap gap-1.5 mb-1">
            {keys.map((k) => (
              <button key={k} onClick={() => setMessage(message + `{{${k}}}`)}
                className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-xs font-mono" type="button">{`{{${k}}}`}</button>
            ))}
          </div>
          <textarea className={input} rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={method === 'whatsapp' ? 'Hello {{name}}, we would like to connect with you about …' : 'Optional note for your records'} />
          {method === 'whatsapp' && !hasPlaceholder && (
            <div className="text-xs text-amber-700 mt-1">Tip: click a tag above like {'{{name}}'} to personalise the message for every contact.</div>
          )}
          {first && (
            <div className="mt-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
              <div className="text-slate-500 mb-1">Preview for {first.name}:</div>
              <div className="whitespace-pre-wrap">{preview}</div>
            </div>
          )}
        </div>
        {method === 'call' && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            A browser can only open your phone dialer with the number ready. Call results are recorded by you after each call.
          </div>
        )}
        <label className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I confirm every selected contact has agreed to receive messages or calls from me, and I will honour any opt-out request immediately.</span>
        </label>
        <div className="flex items-center justify-between gap-3">
          <button onClick={onBack} className={btnGhost}>Back</button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {!consent ? 'Tick the consent box to continue' : !campaignName.trim() ? 'Name your campaign' : `${contacts.filter((c) => c.selected && c.valid && !c.duplicated).length} recipients`}
            </span>
            <button onClick={onNext} disabled={!campaignName.trim() || (!message.trim() && method === 'whatsapp') || !consent || !first} className={btnPrimary}>Start campaign</button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ---------------- Step 3: Execute ---------------- */

interface Stats { done: number; failed: number; skipped: number; pending: number }

function Progress({ stats }: { stats: Stats }) {
  const total = stats.done + stats.failed + stats.skipped + stats.pending || 1;
  const pct = Math.round(((stats.done + stats.failed + stats.skipped) / total) * 100);
  return (
    <div>
      <div className="h-2 rounded bg-slate-200 overflow-hidden flex">
        <div className="bg-emerald-500" style={{ width: `${(stats.done / total) * 100}%` }} />
        <div className="bg-red-400" style={{ width: `${(stats.failed / total) * 100}%` }} />
        <div className="bg-slate-400" style={{ width: `${(stats.skipped / total) * 100}%` }} />
      </div>
      <div className="text-xs text-slate-500 mt-1">{pct}% processed</div>
    </div>
  );
}

function StatBox({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={`p-2 rounded-lg border text-center ${tone ?? 'bg-slate-50 border-slate-200'}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ManualSend({ contacts, method, message, campaignName, paused, setPaused, stopped, stop, retry, onChangeContact, onBack }: {
  contacts: Contact[]; method: Method; message: string; campaignName: string;
  paused: boolean; setPaused: (v: boolean) => void;
  stopped: boolean; stop: () => void; retry: () => void;
  onChangeContact: (id: string, patch: Partial<Contact>) => void; onBack: () => void;
}) {
  const stats = useMemo<Stats>(() => ({
    done: contacts.filter((c) => c.status === 'done').length,
    failed: contacts.filter((c) => c.status === 'failed').length,
    skipped: contacts.filter((c) => c.status === 'skipped').length,
    pending: contacts.filter((c) => c.status === 'pending' || c.status === 'opened').length,
  }), [contacts]);
  const linkFor = (c: Contact) => (method === 'whatsapp' ? whatsappLink(c.waPhone || c.phone, message) : telLink(c.phone));
  const nextPending = contacts.find((c) => c.status === 'pending');
  const disabledCls = paused || stopped ? 'pointer-events-none opacity-40' : '';

  const openNext = () => {
    if (!nextPending) return;
    window.open(linkFor(nextPending), '_blank');
    onChangeContact(nextPending.id, { status: 'opened' });
  };

  return (
    <Panel title={method === 'whatsapp' ? 'Send WhatsApp Messages' : 'Call Recipients'} step={3}>
      <p className="text-xs text-slate-500 mb-4">
        {method === 'whatsapp'
          ? 'Each Open button opens that contact\'s WhatsApp chat with your message pre-filled. WhatsApp never sends automatically - after you send (or decide not to), mark the result. This keeps the app 100% free and within WhatsApp\'s rules.'
          : 'Each Call button opens your phone dialer with the number ready. After the call, mark the result yourself. Your browser cannot place calls automatically or know the outcome.'}
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <StatBox value={stats.done} label="Done" tone="bg-emerald-50 border border-emerald-200" />
        <StatBox value={stats.pending} label="Pending" />
        <StatBox value={stats.failed} label="Failed" tone="bg-red-50 border border-red-200" />
        <StatBox value={stats.skipped} label="Skipped" tone="bg-slate-100 border border-slate-300" />
      </div>
      <Progress stats={stats} />
      <div className="flex flex-wrap gap-2 mt-3">
        <button className={btnPrimary + ' ' + disabledCls} disabled={!nextPending} onClick={openNext}>
          {method === 'whatsapp' ? `Open next (${stats.pending} pending)` : `Open dialer for next (${stats.pending} pending)`}
        </button>
        {paused
          ? <button className={btnGhost} onClick={() => setPaused(false)}>Resume</button>
          : <button className={btnGhost} disabled={stopped} onClick={() => setPaused(true)}>Pause</button>}
        <button className={btnGhost} disabled={stopped} onClick={stop}>Stop campaign</button>
        {(stats.failed + stats.skipped > 0) && <button className={btnGhost} onClick={retry}>Retry failed &amp; skipped ({stats.failed + stats.skipped})</button>}
        <button className={btnGhost} onClick={onBack}>Edit message</button>
        {stopped && <span className="text-xs text-red-600 self-center">Campaign stopped. Pending contacts were not contacted.</span>}
      </div>
      <div className="mt-4 max-h-96 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {contacts.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="w-36 truncate font-medium">{c.name}</span>
            <span className="font-mono text-xs">{c.phone}</span>
            <StatusChip status={c.status} />
            {method === 'whatsapp' ? (
              <a href={whatsappLink(c.waPhone || c.phone, message)} target="_blank" rel="noreferrer"
                onClick={() => onChangeContact(c.id, { status: 'opened' })}
                className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500 text-xs ${disabledCls}`}>Open WhatsApp</a>
            ) : (
              <a href={telLink(c.phone)} onClick={() => onChangeContact(c.id, { status: 'opened' })}
                className={`${btn} bg-slate-800 text-white hover:bg-slate-700 text-xs ${disabledCls}`}>Call</a>
            )}
            <div className="ml-auto flex gap-1">
              <button type="button" className="px-2 py-1 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-800 text-xs" disabled={c.status === 'done'}
                onClick={() => onChangeContact(c.id, { status: 'done' })}>Done</button>
              <button type="button" className="px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700 text-xs" disabled={c.status === 'failed'}
                onClick={() => onChangeContact(c.id, { status: 'failed' })}>Failed</button>
              <button type="button" className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs" disabled={c.status === 'skipped'}
                onClick={() => onChangeContact(c.id, { status: 'skipped' })}>Skip</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>{stats.pending ? 'Work through the list - the progress bar updates live.' : 'All contacts processed.'}</span>
        <a className="underline" href="#" onClick={(e) => { e.preventDefault(); exportResultsCsv(campaignName, contacts, method); }}>Download results (CSV)</a>
      </div>
    </Panel>
  );
}

function VoiceSend({ contacts, campaignName }: { contacts: Contact[]; campaignName: string }) {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [checking, setChecking] = useState(false);
  const [audio, setAudio] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const check = async () => {
    setChecking(true);
    setConn(null);
    const state = await checkVoiceConnection();
    setConn(state);
    setChecking(false);
  };

  const launch = async () => {
    if (!audio || !conn?.providerConfigured) return;
    setRunning(true);
    setResult(null);
    try {
      const asset = await uploadAudio(audio, title || campaignName || 'Voice recording');
      const res = await startVoiceCampaign({
        phones: contacts.map((c) => c.phone),
        names: contacts.map((c) => c.name),
        audioAssetId: asset.id,
        campaignName,
      });
      setResult({
        ok: true,
        text: `${res.dispatchedCalls} recipient(s) accepted by the telephony provider, ${res.suppressedSkipped} skipped (opted-out). Campaign id: ${res.campaignId}. Note: provider acceptance is not proof an answer - final call outcomes appear in the API reports as the provider reports them.`,
      });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Voice campaign failed' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel title="Prerecorded Voice Campaign" step={3}>
      <ol className="text-xs text-slate-500 space-y-1 list-decimal ml-4 mb-4">
        <li>Check the connection to the campaign API - only a server with a telephony provider (e.g. Twilio) can place real calls.</li>
        <li>Upload your MP3/WAV recording (max 10 MB, 180 s).</li>
        <li>Start the campaign - answered recipients hear your recording automatically.</li>
      </ol>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnGhost} onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking…' : '1. Check API connection'}
          </button>
          {conn && (
            conn.ok ? (
              conn.providerConfigured ? (
                <span className="text-xs text-emerald-700">Connected. Telephony provider: {conn.providerName}.</span>
              ) : (
                <span className="text-xs text-amber-700">
                  Connected, but no real telephony provider is configured (adapter: {conn.providerName}). Automated calls are NOT possible and nothing will be dialed. Connect a provider on the API, or use &quot;Direct phone call&quot; to dial manually.
                </span>
              )
            ) : <span className="text-xs text-red-600">{conn.reason}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-600">2. Recording</span>
          <input type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className={input + ' max-w-xs'}
            onChange={(e) => setAudio(e.target.files?.[0] ?? null)} />
          <input className={input + ' max-w-xs'} placeholder="Title for the recording" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <StatBox value={contacts.length} label="recipients" />
          <StatBox value={contacts.filter((c) => c.waPhone && c.waPhone !== c.phone).length} label="use WhatsApp number" />
          <StatBox value={result?.ok ? contacts.length : 0} label="submitted" tone="bg-emerald-50 border border-emerald-200" />
        </div>
        <button type="button" className={btnPrimary} disabled={!conn?.ok || !conn.providerConfigured || !audio || running}
          onClick={() => void launch()}>
          {running ? 'Starting campaign…' : '3. Start voice campaign'}
        </button>
        {conn?.ok && !conn.providerConfigured && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            Automated calling is disabled until a telephony provider is connected to the API. This is expected: dialling real phone numbers needs a paid phone network - no free service provides it. Manual calling stays free via &quot;Direct phone call&quot;.
          </div>
        )}
        {result && (
          <div className={`p-3 rounded-lg border text-xs ${result.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {result.ok ? 'Started: ' : 'Not started: '}{result.text}
          </div>
        )}
        <p className="text-xs text-slate-400">
          API: <span className="font-mono">{API_BASE}</span>. Automated voice calling requires a paid telephony provider; every other feature of this app is free and runs in your browser.
        </p>
      </div>
    </Panel>
  );
}

/* ---------------- App ---------------- */

export function App() {
  const saved = useMemo(() => loadData(), []);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Mapping>(saved?.mapping ?? { name: '', phone: '', waPhone: '', category: '' });
  const [country, setCountry] = useState(saved?.country ?? 'IN');
  const [contacts, setContacts] = useState<Contact[]>(saved?.contacts ?? []);
  const [campaignName, setCampaignName] = useState(saved?.campaignName ?? '');
  const [message, setMessage] = useState(saved?.message ?? '');
  const [method, setMethod] = useState<Method>((saved?.method as Method) ?? 'whatsapp');
  const [consent, setConsent] = useState(saved?.consentConfirmed ?? false);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    saveData({ mapping, country, contacts, campaignName, message, method, consentConfirmed: consent });
  }, [mapping, country, contacts, campaignName, message, method, consent]);

  const onChangeContact = (id: string, patch: Partial<Contact>) =>
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addContacts = () => {
    if (!parsed) return;
    if (contacts.length > 0 && !window.confirm('Add these rows too? Existing contacts stay; same phone numbers are flagged as duplicates.')) return;
    const mapped = mapRowsToContacts(parsed.rows, mapping, country);
    const existing = new Set(contacts.map((c) => c.phone).filter(Boolean));
    for (const c of mapped) {
      if (c.valid && existing.has(c.phone)) { c.duplicated = true; c.selected = false; }
      else if (c.valid) existing.add(c.phone);
    }
    setContacts((prev) => [...prev, ...mapped]);
    setParsed(null);
  };

  const selected = contacts.filter((c) => c.selected && c.valid && !c.duplicated);

  const retry = () => {
    setContacts((cs) => cs.map((c) => (c.selected && ['failed', 'skipped', 'opened'].includes(c.status) ? { ...c, status: 'pending' } : c)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-bold">Campaign Sender</h1>
            <p className="text-xs text-slate-500">Upload contacts → write message → send &amp; track</p>
          </div>
          {contacts.length > 0 && (
            <button onClick={() => { if (window.confirm('Delete all imported contacts, messages and results from this browser?')) { clearData(); location.reload(); } }}
              className="text-xs text-slate-400 hover:text-red-600">Clear all data</button>
          )}
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          {[1, 2, 3].map((n, i) => (
            <React.Fragment key={n}>
              {i > 0 && <span className="text-slate-300">→</span>}
              <span className={step === n ? 'text-slate-900 font-bold' : ''}>{['Upload contacts', 'Message & method', 'Send & results'][i]}</span>
            </React.Fragment>
          ))}
        </div>

        <ContactsStep
          parsed={parsed} setParsed={setParsed} mapping={mapping} setMapping={setMapping}
          country={country} setCountry={setCountry} contacts={contacts} addContacts={addContacts}
          onChangeContact={onChangeContact}
          removeContact={(id) => setContacts((cs) => cs.filter((c) => c.id !== id))}
          removeInvalid={() => setContacts((cs) => cs.filter((c) => c.valid))}
          onNext={() => setStep(2)}
        />

        {step >= 2 && selected.length > 0 && (
          <ComposeStep
            contacts={contacts} campaignName={campaignName} setCampaignName={setCampaignName}
            message={message} setMessage={setMessage} method={method} setMethod={setMethod}
            consent={consent} setConsent={setConsent} onBack={() => setStep(1)}
            onNext={() => { setPaused(false); setStopped(false); setStep(3); }}
          />
        )}

        {step >= 3 && selected.length > 0 && campaignName && consent && (
          method === 'voice'
            ? <VoiceSend contacts={selected} campaignName={campaignName} />
            : <ManualSend contacts={selected} method={method} message={message} campaignName={campaignName}
                paused={paused} setPaused={setPaused} stopped={stopped}
                stop={() => { setStopped(true); setPaused(false); }} retry={retry}
                onChangeContact={onChangeContact} onBack={() => setStep(2)} />
        )}
      </main>
      <footer className="max-w-3xl mx-auto px-4 pb-8 text-center text-xs text-slate-400">
        All contact data stays in your browser (localStorage) until you clear it. WhatsApp and phone-call actions stay free because you press send / dial yourself.
      </footer>
    </div>
  );
}
