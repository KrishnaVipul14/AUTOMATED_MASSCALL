import 'dotenv/config';
import { loadConfig, AppConfig } from '@commhub/configuration';

let cached: AppConfig | undefined;
export function config(): AppConfig {
  if (!cached) cached = loadConfig(process.env);
  return cached;
}
/** Test helper: force re-read of env. */
export function resetConfig() {
  cached = undefined;
}
