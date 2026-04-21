import { describe, test, expect } from 'bun:test';
import {
  session,
  sign,
  unsign,
  createMemorySessionStore,
  createRedisSessionStore,
  csrfSyncToken,
  csrfSyncVerify,
  type SessionHandle,
  type RedisSessionClient,
} from '../src/session';
import { Context } from '../src/context';

const SECRET = 'test-secret-0123456789';

/* ═════════════ SIGNING ═════════════ */

describe('sign / unsign', () => {
  test('roundtrip', async () => {
    const signed = await sign('hello', SECRET);
    expect(signed).toContain('hello.');
    expect(await unsign(signed, SECRET)).toBe('hello');
  });

  test('rejects wrong secret', async () => {
    const signed = await sign('hello', SECRET);
    expect(await unsign(signed, 'wrong-secret')).toBeNull();
  });

  test('rejects tampered payload', async () => {
    const signed = await sign('hello', SECRET);
    const tampered = 'bye' + signed.slice(signed.indexOf('.'));
    expect(await unsign(tampered, SECRET)).toBeNull();
  });

  test('rejects missing signature', async () => {
    expect(await unsign('no-signature-here', SECRET)).toBeNull();
  });
});

/* ═════════════ MEMORY STORE ═════════════ */

describe('createMemorySessionStore', () => {
  test('sets and retrieves data', async () => {
    const store = createMemorySessionStore();
    await store.set('sid1', { userId: 42 }, 60);
    expect(await store.get('sid1')).toEqual({ userId: 42 });
  });

  test('destroy removes session', async () => {
    const store = createMemorySessionStore();
    await store.set('sid2', { x: 1 }, 60);
    await store.destroy('sid2');
    expect(await store.get('sid2')).toBeNull();
  });

  test('expired sessions return null', async () => {
    const store = createMemorySessionStore();
    await store.set('sid3', { x: 1 }, -1);
    expect(await store.get('sid3')).toBeNull();
  });

  test('cleanup removes expired entries', async () => {
    const store = createMemorySessionStore();
    await store.set('live', { x: 1 }, 60);
    await store.set('dead', { x: 2 }, -1);
    await store.cleanup!();
    expect(await store.get('live')).not.toBeNull();
    expect(await store.get('dead')).toBeNull();
  });
});

/* ═════════════ SESSION MIDDLEWARE ═════════════ */

async function runMiddleware(
  req: Request,
  middleware: ReturnType<typeof session>,
  handler: (ctx: Context) => Promise<Response | void> | Response | void,
): Promise<{ ctx: Context; response: Response | null }> {
  const ctx = new Context(req);
  let response: Response | null = null;
  await middleware(ctx, async () => {
    const r = await handler(ctx);
    if (r instanceof Response) response = r;
  });
  return { ctx, response };
}

function extractSetCookie(ctx: Context): string[] {
  // @ts-expect-error access private for tests
  return [...ctx['_setCookies']];
}

describe('session middleware · lifecycle', () => {
  test('creates new session on first request', async () => {
    const mw = session({ secret: SECRET });
    const req = new Request('http://localhost/');

    const { ctx } = await runMiddleware(req, mw, (c) => {
      const s = c.get<SessionHandle>('session')!;
      expect(typeof s.id).toBe('string');
      s.userId = 42;
    });

    const cookies = extractSetCookie(ctx);
    expect(cookies.some((c) => c.startsWith('vajra.sid='))).toBe(true);
  });

  test('reads existing session on subsequent request', async () => {
    const store = createMemorySessionStore();
    const mw = session({ secret: SECRET, store });

    // First request: create session
    const req1 = new Request('http://localhost/');
    const { ctx: ctx1 } = await runMiddleware(req1, mw, (c) => {
      const s = c.get<SessionHandle>('session')!;
      s.userId = 99;
    });

    // Extract session cookie
    const cookies = extractSetCookie(ctx1);
    const sidCookie = cookies.find((c) => c.startsWith('vajra.sid='))!;
    const cookieValue = sidCookie.split(';')[0]!.replace('vajra.sid=', '');

    // Second request: reuse cookie
    const req2 = new Request('http://localhost/', {
      headers: { cookie: `vajra.sid=${cookieValue}` },
    });
    let recovered = 0;
    await runMiddleware(req2, mw, (c) => {
      const s = c.get<SessionHandle>('session')!;
      recovered = s.userId as number;
    });
    expect(recovered).toBe(99);
  });

  test('ignores tampered cookie and creates new session', async () => {
    const mw = session({ secret: SECRET });
    const req = new Request('http://localhost/', {
      headers: { cookie: 'vajra.sid=tamperedvalue' },
    });

    let sid1 = '';
    await runMiddleware(req, mw, (c) => {
      sid1 = c.get<SessionHandle>('session')!.id;
    });
    expect(sid1).toBeTruthy();
  });

  test('regenerate creates new ID', async () => {
    const mw = session({ secret: SECRET });
    const req = new Request('http://localhost/');

    let oldId = '';
    let newId = '';
    await runMiddleware(req, mw, async (c) => {
      const s = c.get<SessionHandle>('session')!;
      oldId = s.id;
      await s.regenerate();
      newId = s.id;
    });

    expect(oldId).not.toBe(newId);
    expect(oldId.length).toBeGreaterThan(10);
    expect(newId.length).toBeGreaterThan(10);
  });

  test('destroy clears the session cookie', async () => {
    const store = createMemorySessionStore();
    const mw = session({ secret: SECRET, store });
    const req = new Request('http://localhost/');

    const { ctx } = await runMiddleware(req, mw, async (c) => {
      const s = c.get<SessionHandle>('session')!;
      s.userId = 1;
      await s.destroy();
    });

    const cookies = extractSetCookie(ctx);
    expect(cookies.some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  test('skipPaths bypasses session', async () => {
    const mw = session({ secret: SECRET, skipPaths: ['/health'] });
    const req = new Request('http://localhost/health');

    const { ctx } = await runMiddleware(req, mw, (c) => {
      expect(c.get('session')).toBeUndefined();
    });

    const cookies = extractSetCookie(ctx);
    expect(cookies.length).toBe(0);
  });

  test('rolling=true refreshes cookie even without changes', async () => {
    const store = createMemorySessionStore();
    const mw = session({ secret: SECRET, store, rolling: true });

    const req1 = new Request('http://localhost/');
    const { ctx: ctx1 } = await runMiddleware(req1, mw, () => {});
    const cookies1 = extractSetCookie(ctx1);
    // New session always sets cookie
    expect(cookies1.length).toBeGreaterThan(0);

    const sidCookie = cookies1.find((c) => c.startsWith('vajra.sid='))!;
    const cookieValue = sidCookie.split(';')[0]!.replace('vajra.sid=', '');

    const req2 = new Request('http://localhost/', {
      headers: { cookie: `vajra.sid=${cookieValue}` },
    });
    const { ctx: ctx2 } = await runMiddleware(req2, mw, () => {});
    const cookies2 = extractSetCookie(ctx2);
    expect(cookies2.length).toBeGreaterThan(0);
  });
});

/* ═════════════ REDIS STORE ═════════════ */

function createFakeRedis(): RedisSessionClient {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) { store.delete(key); return null; }
      return entry.value;
    },
    async set(key, value, opts) {
      const ttl = opts?.EX ?? opts?.ex ?? 3600;
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return 'OK';
    },
    async del(key) {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
  };
}

describe('Redis session store', () => {
  test('roundtrip set/get/destroy', async () => {
    const redis = createFakeRedis();
    const store = createRedisSessionStore(redis);

    await store.set('sid-r', { email: 'x@y.z' }, 60);
    expect(await store.get('sid-r')).toEqual({ email: 'x@y.z' });

    await store.destroy('sid-r');
    expect(await store.get('sid-r')).toBeNull();
  });

  test('integrates with session middleware', async () => {
    const redis = createFakeRedis();
    const store = createRedisSessionStore(redis);
    const mw = session({ secret: SECRET, store });

    const req1 = new Request('http://localhost/');
    const { ctx: ctx1 } = await runMiddleware(req1, mw, (c) => {
      const s = c.get<SessionHandle>('session')!;
      s.count = 1;
    });

    const sidCookie = extractSetCookie(ctx1).find((c) => c.startsWith('vajra.sid='))!;
    const cookieValue = sidCookie.split(';')[0]!.replace('vajra.sid=', '');

    const req2 = new Request('http://localhost/', {
      headers: { cookie: `vajra.sid=${cookieValue}` },
    });
    let count = 0;
    await runMiddleware(req2, mw, (c) => {
      const s = c.get<SessionHandle>('session')!;
      count = s.count as number;
    });
    expect(count).toBe(1);
  });
});

/* ═════════════ CSRF SYNC TOKEN ═════════════ */

describe('csrfSyncToken / csrfSyncVerify', () => {
  test('roundtrip', async () => {
    const token = await csrfSyncToken('sid-123', SECRET);
    expect(await csrfSyncVerify(token, 'sid-123', SECRET)).toBe(true);
  });

  test('rejects wrong session ID', async () => {
    const token = await csrfSyncToken('sid-a', SECRET);
    expect(await csrfSyncVerify(token, 'sid-b', SECRET)).toBe(false);
  });

  test('rejects tampered token', async () => {
    const token = await csrfSyncToken('sid-x', SECRET);
    const tampered = 'modified' + token.slice(8);
    expect(await csrfSyncVerify(tampered, 'sid-x', SECRET)).toBe(false);
  });

  test('rejects wrong secret', async () => {
    const token = await csrfSyncToken('sid-y', SECRET);
    expect(await csrfSyncVerify(token, 'sid-y', 'wrong-secret')).toBe(false);
  });

  test('rejects expired token', async () => {
    const token = await csrfSyncToken('sid-z', SECRET);
    expect(await csrfSyncVerify(token, 'sid-z', SECRET, -1)).toBe(false);
  });
});
