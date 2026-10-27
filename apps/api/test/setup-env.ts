// Jest setup: always run integration tests against the dedicated test database, in MOCK mode.
import { config as load } from 'dotenv';
import { resolve } from 'node:path';
load({ path: resolve(__dirname, '../.env') });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? (process.env.DATABASE_URL ?? '').replace(/\/commhub(\?|$)/, '/commhub_test$1');
process.env.PROVIDER_MODE = 'MOCK';
process.env.NODE_ENV = 'test';
process.env.LOGIN_RATE_LIMIT = '1000';
