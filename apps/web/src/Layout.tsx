import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, Users, Megaphone, PhoneCall, MessageSquare, CalendarClock,
  BarChart3, CheckSquare, FileCheck2, Shield, ServerCog, Settings, OctagonAlert, Sun, Moon, LogOut,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth-context';

export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/voice', label: 'Voice Announcements', icon: PhoneCall },
  { to: '/sms', label: 'SMS Messages', icon: MessageSquare },
  { to: '/scheduler', label: 'Scheduler', icon: CalendarClock },
  { to: '/reports', label: 'Reports and Analytics', icon: BarChart3 },
  { to: '/approvals', label: 'Approval Queue', icon: CheckSquare },
  { to: '/audit', label: 'Audit Logs', icon: FileCheck2 },
  { to: '/team', label: 'Team and Permissions', icon: Shield },
  { to: '/providers', label: 'Provider Configuration', icon: ServerCog },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Layout() {
  const { user, logout, can } = useAuth();
  const qc = useQueryClient();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const summary = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => api<{ mode: string; emergencyStop: boolean }>('/dashboard/summary'),
  });

  const toggleStop = useMutation({
    mutationFn: (active: boolean) => api('/settings/emergency-stop', { method: 'POST', body: JSON.stringify({ active, reason: 'Operator toggle from header' }) }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const toggleTheme = () => {
    document.documentElement.classList.toggle('dark');
    setDark(document.documentElement.classList.contains('dark'));
  };

  const mode = summary.data?.mode ?? 'MOCK';
  const stopped = summary.data?.emergencyStop ?? false;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50 dark:bg-slate-950">
      <aside className="w-full md:w-64 bg-slate-900 text-slate-100 flex-shrink-0 flex flex-col">
        <div className="p-4 border-b border-slate-800">
          <div className="text-xs uppercase tracking-wider text-amber-400 font-semibold">Internal Operations</div>
          <div className="text-lg font-bold">CommHub Platform</div>
          <div className="text-xs text-slate-400 mt-0.5">Authorised Public Communications</div>
        </div>
        <nav aria-label="Main navigation" className="p-2 space-y-0.5 flex-1 overflow-y-auto">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800 text-xs text-slate-300 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-white">{user?.name}</div>
              <div className="text-slate-400">{user?.email} · <span className="text-indigo-300">{user?.role}</span></div>
            </div>
            <button onClick={toggleTheme} aria-label="Toggle theme" className="p-1.5 rounded hover:bg-slate-800">
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
          <button
            onClick={() => void logout()}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                mode === 'MOCK'
                  ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 border border-amber-300'
                  : 'bg-emerald-100 text-emerald-900'
              }`}
            >
              {mode === 'MOCK' ? 'SIMULATION / MOCK MODE — No real recipients are contacted' : `MODE: ${mode}`}
            </span>
            {stopped && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-600 text-white">
                EMERGENCY STOP ACTIVE — All new provider submissions halted
              </span>
            )}
          </div>
          {can('campaigns:control') && (
            <button
              onClick={() => {
                if (stopped || window.confirm('Activate EMERGENCY STOP? This immediately pauses active campaigns and prevents workers from submitting new requests.')) {
                  toggleStop.mutate(!stopped);
                }
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold ${
                stopped ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'
              }`}
            >
              <OctagonAlert className="w-4 h-4" />
              {stopped ? 'Clear Emergency Stop' : 'Emergency Stop'}
            </button>
          )}
        </header>

        <main className="p-6 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
