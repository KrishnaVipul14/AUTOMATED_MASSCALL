import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App';
import { templateKeys, fillTemplate, whatsappLink, telLink } from './lib/message';
import { mapRowsToContacts, guessMapping } from './lib/contacts';
import { normalisePhone } from './lib/phone';

describe('phone number handling', () => {
  it('normalises Indian numbers without country code', () => {
    expect(normalisePhone('98765 43210').e164).toBe('+919876543210');
    expect(normalisePhone('09876543210').e164).toBe('+919876543210');
  });
  it('normalises numbers with an explicit country code', () => {
    expect(normalisePhone('+919876543210').e164).toBe('+919876543210');
    expect(normalisePhone('+12025550123').e164).toBe('+12025550123');
  });
  it('rejects invalid or too-short values', () => {
    expect(normalisePhone('123').e164).toBeNull();
    expect(normalisePhone('not-a-phone').e164).toBeNull();
    expect(normalisePhone('').e164).toBeNull();
  });
});

describe('message personalisation', () => {
  const c = { name: 'Rahul', phone: '+919876543210', category: 'Trader', vars: { business: 'ABC Traders', location: 'Pune' } };
  it('replaces known placeholders and keeps unknown ones', () => {
    const out = fillTemplate('Hello {{name}}, we would like to connect with {{business}} in {{location}}. {{vip}}', c);
    expect(out).toBe('Hello Rahul, we would like to connect with ABC Traders in Pune. {{vip}}');
  });
  it('exposes extra mapped columns as template keys', () => {
    expect(templateKeys([c]).sort()).toEqual(['business', 'category', 'location', 'name', 'phone']);
  });
});

describe('link generation', () => {
  it('builds wa.me links with encoded message text', () => {
    expect(whatsappLink('+919876543210', 'Hello Rahul!')).toBe('https://wa.me/919876543210?text=Hello%20Rahul!');
  });
  it('builds tel: links', () => {
    expect(telLink('+919876543210')).toBe('tel:+919876543210');
  });
});

describe('contact import mapping', () => {
  it('guesses common column names', () => {
    const m = guessMapping(['S/N', 'Full Name', 'WhatsApp Number', 'Mobile Phone', 'Category']);
    expect(m.name).toBe('Full Name');
    expect(m.phone).toBe('Mobile Phone');
    expect(m.waPhone).toBe('WhatsApp Number');
    expect(m.category).toBe('Category');
  });
  it('maps rows with validation, dedupe and variables', () => {
    const rows: { [c: string]: string }[] = [
      { Name: 'Rahul', Mobile: '98765 43210', WhatsApp: '9876500011', Category: 'Trader', Business: 'ABC Traders' },
      { Name: 'Sunita', Mobile: '+919876543210', Category: '', Business: '' },
      { Name: 'Bad', Mobile: '123', Category: '', Business: '' },
    ];
    const contacts = mapRowsToContacts(rows, { name: 'Name', phone: 'Mobile', waPhone: 'WhatsApp', category: 'Category' }, 'IN');
    expect(contacts[0].valid).toBe(true);
    expect(contacts[0].phone).toBe('+919876543210');
    expect(contacts[0].waPhone).toBe('+919876500011');
    expect(contacts[0].vars.business).toBe('ABC Traders');
    expect(contacts[0].selected).toBe(true);
    expect(contacts[1].duplicated).toBe(true);
    expect(contacts[1].selected).toBe(false);
    expect(contacts[2].valid).toBe(false);
    expect(contacts[2].reason).toContain('Not a valid');
  });
});

describe('the app UI (three-step wizard)', () => {
  afterEach(() => {
    localStorage.removeItem('campaign-sender:v1');
    vi.unstubAllGlobals();
  });

  it('shows the upload step first and explains it needs phone numbers', () => {
    render(<App />);
    expect(screen.getByText('Upload Contacts')).toBeInTheDocument();
    expect(screen.getByText(/Choose CSV or Excel file/i)).toBeInTheDocument();
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
  });

  function seedContacts() {
    const contactFixtures = mapRowsToContacts(
      [{ Name: 'Rahul', Mobile: '9876543210' }],
      { name: 'Name', phone: 'Mobile', waPhone: '', category: '' },
      'IN',
    );
    localStorage.setItem(
      'campaign-sender:v1',
      JSON.stringify({
        mapping: { name: 'Name', phone: 'Mobile', waPhone: '', category: '' },
        country: 'IN',
        contacts: contactFixtures,
        campaignName: 'Test campaign',
        message: 'Hello {{name}}, please confirm.',
        method: 'whatsapp',
        consentConfirmed: true,
      }),
    );
  }

  it('shows the compose and send steps with honest WhatsApp wording', async () => {
    seedContacts();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Message and Method')).toBeInTheDocument();
    expect(screen.getByText('Preview for Rahul:')).toBeInTheDocument();
    expect(screen.getByText('Hello Rahul, please confirm.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    expect(screen.getByText('Send WhatsApp Messages')).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp never sends automatically/)).toBeInTheDocument();
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
  });

  it('shows the honest provider warning for the voice method when the API has no telephony provider', async () => {
    seedContacts();
    localStorage.setItem(
      'campaign-sender:v1',
      JSON.stringify({
        ...JSON.parse(localStorage.getItem('campaign-sender:v1')!),
        method: 'voice',
        message: '',
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/auto-token')) {
        return new Response(JSON.stringify({ accessToken: 'tok-123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/dashboard/summary')) {
        return new Response(
          JSON.stringify({ providers: { configs: [{ channel: 'VOICE', adapter: 'mock', enabled: true, mode: 'MOCK', approvalVerified: false }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    expect(screen.getByText('Prerecorded Voice Campaign')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1\. Check API connection/ }));
    await waitFor(() => expect(screen.getByText(/Automated calling is disabled until a telephony provider/i)).toBeInTheDocument());
  });
});
