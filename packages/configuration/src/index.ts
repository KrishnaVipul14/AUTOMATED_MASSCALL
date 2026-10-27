import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  PROVIDER_MODE: z.enum(['MOCK', 'TEST', 'PRODUCTION']).default('MOCK'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./.storage'),
  WEBHOOK_SIGNING_SECRET: z.string().default(''),
  PORT: z.coerce.number().default(3000),
});
export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const cfg = schema.parse(env);
  if (cfg.PROVIDER_MODE === 'PRODUCTION' && !cfg.WEBHOOK_SIGNING_SECRET) {
    throw new Error('PRODUCTION mode requires WEBHOOK_SIGNING_SECRET');
  }
  return cfg;
}

export interface ProductionGate {
  providerApprovalVerified: boolean;
  credentialsConfigured: boolean;
  complianceChecklistComplete: boolean;
}
/** Real communications are allowed only when mode is PRODUCTION and every gate is satisfied. */
export function productionAllowed(mode: AppConfig['PROVIDER_MODE'], g: ProductionGate): boolean {
  return mode === 'PRODUCTION' && g.providerApprovalVerified && g.credentialsConfigured && g.complianceChecklistComplete;
}
