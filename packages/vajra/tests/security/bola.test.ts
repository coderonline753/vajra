import { describe, it, expect } from 'bun:test';
import { Vajra, jwt, jwtSign, bola } from '../../src/index';

describe('BOLA Protection', () => {
  const secret = 'test-secret';

  it('allows access when user matches resource owner', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({ ownerParam: 'id', userKey: 'userId' }),
      (c) => c.json({ access: 'granted' })
    );

    const token = await jwtSign({ userId: '42' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.access).toBe('granted');
  });

  it('denies access when user does not match', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({ ownerParam: 'id', userKey: 'userId' }),
      (c) => c.json({ access: 'granted' })
    );

    const token = await jwtSign({ userId: '99' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(403);
  });

  it('admin bypass allows any access', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({
        ownerParam: 'id',
        userKey: 'userId',
        adminBypass: (c) => (c.get('jwtPayload') as any)?.role === 'admin',
      }),
      (c) => c.json({ access: 'granted' })
    );

    const token = await jwtSign({ userId: '99', role: 'admin' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
  });

  it('custom userExtractor works', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({
        ownerParam: 'id',
        userExtractor: (c) => (c.get('jwtPayload') as any)?.sub,
      }),
      (c) => c.json({ access: 'granted' })
    );

    const token = await jwtSign({ sub: '42' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
  });

  it('no authenticated user returns 403', async () => {
    const app = new Vajra();
    app.use(async (c, next) => next()); // no auth middleware
    app.get('/users/:id/data',
      bola({ ownerParam: 'id' }),
      (c) => c.json({ access: 'granted' })
    );

    const res = await app.handle(new Request('http://localhost/users/42/data'));
    expect(res.status).toBe(403);
  });

  it('numeric comparison works (both converted to string)', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({ ownerParam: 'id', userKey: 'userId' }),
      (c) => c.json({ ok: true })
    );

    // JWT has numeric userId, route param is string
    const token = await jwtSign({ userId: 42 }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
  });

  it('custom onDenied handler', async () => {
    const app = new Vajra();
    app.get('/users/:id/data',
      jwt({ secret }),
      bola({
        ownerParam: 'id',
        userKey: 'userId',
        onDenied: (c) => c.json({ custom: 'denied' }, 403),
      }),
      (c) => c.json({ ok: true })
    );

    const token = await jwtSign({ userId: '99' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/users/42/data', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.custom).toBe('denied');
  });
});
