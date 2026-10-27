import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../main';

export const TEST_PASSWORD = 'Test-Password-123!';
export const prisma = new PrismaClient();

/** Wipes every table in the TEST database. Refuses to run against anything else. */
export async function resetDb() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('commhub_test')) throw new Error('Refusing to reset a non-test database');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(',')} CASCADE`);
}

let hash: string | undefined;
export async function createUser(role: Role, email = `${role.toLowerCase()}@test.local`) {
  hash ??= await bcrypt.hash(TEST_PASSWORD, 4);
  return prisma.user.create({ data: { email, name: role, role, passwordHash: hash } });
}

export async function createApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

export async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

/** Creates one user per role and returns their access tokens. */
export async function setupRoles(app: INestApplication) {
  const tokens = {} as Record<Role, string>;
  for (const r of ['ADMIN', 'OPERATOR', 'APPROVER', 'AUDITOR'] as Role[]) {
    const u = await createUser(r);
    tokens[r] = await login(app, u.email);
  }
  return tokens;
}
