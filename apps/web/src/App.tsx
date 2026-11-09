import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth-context';
import { Layout } from './Layout';
import {
  AuditPage, CampaignsPage, ContactsPage, DashboardPage,
  ProvidersPage, ReportsPage, SchedulerPage, SettingsPage, SmsPage, TeamPage, VoicePage,
} from './pages';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/voice" element={<VoicePage />} />
        <Route path="/sms" element={<SmsPage />} />
        <Route path="/scheduler" element={<SchedulerPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/approvals" element={<CampaignsPage onlyPending />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
