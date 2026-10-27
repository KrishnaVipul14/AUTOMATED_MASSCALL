import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App';
import { NAV_ITEMS } from './Layout';

describe('CommHub Frontend Workflows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defines all 12 required sidebar navigation sections', () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual([
      'Dashboard',
      'Contacts',
      'Campaigns',
      'Voice Announcements',
      'SMS Messages',
      'Scheduler',
      'Reports and Analytics',
      'Approval Queue',
      'Audit Logs',
      'Team and Permissions',
      'Provider Configuration',
      'Settings',
    ]);
  });

  it('renders the login screen when unauthenticated and logs in to the MOCK mode dashboard', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) return new Response('{}', { status: 401 });
      if (url.endsWith('/api/auth/login')) {
        return new Response(
          JSON.stringify({ accessToken: 'tok', user: { id: '1', email: 'admin@demo.local', name: 'Demo Admin', role: 'ADMIN' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/dashboard/summary')) {
        return new Response(
          JSON.stringify({
            mode: 'MOCK',
            emergencyStop: false,
            contacts: { total: 25, eligible: 24, suppressionRecords: 1 },
            campaignsByStatus: { DRAFT: 1 },
            pendingOutboxJobs: 0,
            outcomes: {},
            recentActivity: [],
            providers: { configs: [{ channel: 'SMS', adapter: 'mock', enabled: true, mode: 'MOCK', approvalVerified: false }], errorsLast24h: 0 },
            usage: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('Sign in to CommHub')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

    expect(await screen.findByText(/SIMULATION \/ MOCK MODE/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Operational Overview')).toBeInTheDocument());
    expect(screen.getByText('24')).toBeInTheDocument(); // eligible contacts
  });
});
