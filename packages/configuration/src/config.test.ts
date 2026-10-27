import { describe, it, expect } from 'vitest';
import { loadConfig, productionAllowed } from './index';

const base = { DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'a'.repeat(16), JWT_REFRESH_SECRET: 'b'.repeat(16) };

describe('config', () => {
  it('defaults to MOCK mode', () => expect(loadConfig(base).PROVIDER_MODE).toBe('MOCK'));
  it('rejects short secrets', () => expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: 'x' })).toThrow());
  it('requires webhook secret in production', () =>
    expect(() => loadConfig({ ...base, PROVIDER_MODE: 'PRODUCTION' })).toThrow());
  it('blocks production until all gates pass', () => {
    const g = { providerApprovalVerified: true, credentialsConfigured: true, complianceChecklistComplete: false };
    expect(productionAllowed('PRODUCTION', g)).toBe(false);
    expect(productionAllowed('MOCK', { ...g, complianceChecklistComplete: true })).toBe(false);
    expect(productionAllowed('PRODUCTION', { ...g, complianceChecklistComplete: true })).toBe(true);
  });
});
