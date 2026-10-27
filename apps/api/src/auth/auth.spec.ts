import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, createUser, prisma, resetDb, TEST_PASSWORD, setupRoles } from '../test-utils/helpers';

describe('Auth & RBAC (integration)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    await resetDb();
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects bad credentials with a generic message and logs the failure', async () => {
    const u = await createUser('OPERATOR', 'op1@test.local');
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email: u.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed', entityId: u.id } })).toBe(1);
  });

  it('locks an account after 5 failed attempts', async () => {
    const u = await createUser('OPERATOR', 'lock@test.local');
    await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 4 } });
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: u.email, password: 'nope' });
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email: u.email, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/locked/);
  });

  it('logs in, sets an httpOnly refresh cookie, rotates it, and detects reuse', async () => {
    const u = await createUser('AUDITOR', 'rt@test.local');
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/auth/login').send({ email: u.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'][0] as string;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const r1 = await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', cookie.split(';')[0]);
    expect(r1.status).toBe(200);
    // Reusing the old (now revoked) token must fail and revoke all sessions.
    const reuse = await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', cookie.split(';')[0]);
    expect(reuse.status).toBe(401);
    expect(await prisma.session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
  });

  it('requires a token for protected routes', async () => {
    expect((await request(app.getHttpServer()).get('/api/dashboard/summary')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/dashboard/summary').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  describe('role permissions', () => {
    let t: Awaited<ReturnType<typeof setupRoles>>;
    beforeAll(async () => {
      await prisma.user.deleteMany({ where: { email: { in: ['admin@test.local', 'operator@test.local', 'approver@test.local', 'auditor@test.local'] } } });
      t = await setupRoles(app);
    });

    it('only administrators can manage users', async () => {
      for (const role of ['OPERATOR', 'APPROVER', 'AUDITOR'] as const) {
        const res = await request(app.getHttpServer()).get('/api/users').set('Authorization', `Bearer ${t[role]}`);
        expect(res.status).toBe(403);
      }
      const ok = await request(app.getHttpServer()).get('/api/users').set('Authorization', `Bearer ${t.ADMIN}`);
      expect(ok.status).toBe(200);
      expect(ok.body[0].passwordHash).toBeUndefined();
    });

    it('an operator cannot grant themselves admin', async () => {
      const me = await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${t.OPERATOR}`);
      const res = await request(app.getHttpServer()).patch(`/api/users/${me.body.id}`).set('Authorization', `Bearer ${t.OPERATOR}`).send({ role: 'ADMIN' });
      expect(res.status).toBe(403);
    });

    it('an admin cannot change their own role or deactivate themselves', async () => {
      const me = await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${t.ADMIN}`);
      const res = await request(app.getHttpServer()).patch(`/api/users/${me.body.id}`).set('Authorization', `Bearer ${t.ADMIN}`).send({ role: 'AUDITOR' });
      expect(res.status).toBe(403);
    });

    it('deactivating a user immediately invalidates their access token', async () => {
      const victim = await createUser('OPERATOR', 'deact@test.local');
      const res0 = await request(app.getHttpServer()).post('/api/auth/login').send({ email: victim.email, password: TEST_PASSWORD });
      const token = res0.body.accessToken;
      const upd = await request(app.getHttpServer()).patch(`/api/users/${victim.id}`).set('Authorization', `Bearer ${t.ADMIN}`).send({ active: false });
      expect(upd.status).toBe(200);
      expect((await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
      expect(await prisma.auditLog.count({ where: { action: 'user.updated', entityId: victim.id } })).toBe(1);
    });

    it('rejects weak passwords on user creation', async () => {
      const res = await request(app.getHttpServer()).post('/api/users').set('Authorization', `Bearer ${t.ADMIN}`)
        .send({ email: 'new@test.local', name: 'N', role: 'OPERATOR', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('dashboard summary is readable by auditors and reports mock mode', async () => {
      const res = await request(app.getHttpServer()).get('/api/dashboard/summary').set('Authorization', `Bearer ${t.AUDITOR}`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('MOCK');
      expect(res.body.contacts).toHaveProperty('eligible');
    });
  });

  // Keep last: exhausts the login throttle for this app instance.
  it('rate-limits login attempts', async () => {
    process.env.LOGIN_RATE_LIMIT = '2';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'x@test.local', password: 'y' })).status);
      }
      expect(statuses[2]).toBe(429);
    } finally {
      process.env.LOGIN_RATE_LIMIT = '1000';
    }
  });
});
