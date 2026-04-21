import { describe, test, expect } from 'bun:test';
import {
  Vajra,
  getRequestContext,
  setRequestContext,
  getRequestContextAll,
  hasRequestContext,
  contextStorage,
} from '../src/index';

describe('Request context (auto-wrap)', () => {
  test('getRequestContext works without any middleware', async () => {
    const app = new Vajra();
    app.get('/who', (c) => {
      const traceId = getRequestContext<string>('traceId');
      const path = getRequestContext<string>('path');
      const method = getRequestContext<string>('method');
      return c.json({ traceId, path, method, inside: hasRequestContext() });
    });

    const res = await app.handle(new Request('http://localhost/who'));
    const body = await res.json() as { traceId: string; path: string; method: string; inside: boolean };
    expect(body.inside).toBe(true);
    expect(body.path).toBe('/who');
    expect(body.method).toBe('GET');
    expect(typeof body.traceId).toBe('string');
    expect(body.traceId.length).toBeGreaterThan(0);
  });

  test('setRequestContext works deep in async chain', async () => {
    const app = new Vajra();

    async function deepService() {
      setRequestContext('userId', 'u-42');
    }

    app.get('/chain', async (c) => {
      await deepService();
      await new Promise(r => setTimeout(r, 1));
      const uid = getRequestContext<string>('userId');
      return c.json({ uid });
    });

    const res = await app.handle(new Request('http://localhost/chain'));
    const body = await res.json() as { uid: string };
    expect(body.uid).toBe('u-42');
  });

  test('parallel requests get isolated contexts', async () => {
    const app = new Vajra();

    app.get('/isolate', async (c) => {
      const userId = c.query('u');
      setRequestContext('userId', userId);
      // Tiny delay so contexts interleave
      await new Promise(r => setTimeout(r, Math.random() * 5));
      return c.json({ userId: getRequestContext<string>('userId') });
    });

    const results = await Promise.all([
      app.handle(new Request('http://localhost/isolate?u=alice')).then(r => r.json()),
      app.handle(new Request('http://localhost/isolate?u=bob')).then(r => r.json()),
      app.handle(new Request('http://localhost/isolate?u=carol')).then(r => r.json()),
      app.handle(new Request('http://localhost/isolate?u=dave')).then(r => r.json()),
    ]);

    expect((results[0] as { userId: string }).userId).toBe('alice');
    expect((results[1] as { userId: string }).userId).toBe('bob');
    expect((results[2] as { userId: string }).userId).toBe('carol');
    expect((results[3] as { userId: string }).userId).toBe('dave');
  });

  test('incoming x-request-id is honored as traceId', async () => {
    const app = new Vajra();
    app.get('/trace', (c) => c.json({ traceId: getRequestContext<string>('traceId') }));

    const req = new Request('http://localhost/trace', {
      headers: { 'x-request-id': 'caller-provided-123' },
    });
    const res = await app.handle(req);
    const body = await res.json() as { traceId: string };
    expect(body.traceId).toBe('caller-provided-123');
  });

  test('getRequestContextAll returns method/path/traceId baseline', async () => {
    const app = new Vajra();
    app.get('/all', (c) => c.json({ all: getRequestContextAll() }));

    const res = await app.handle(new Request('http://localhost/all?x=1'));
    const body = await res.json() as { all: Record<string, string> };
    expect(body.all.path).toBe('/all');
    expect(body.all.method).toBe('GET');
    expect(typeof body.all.traceId).toBe('string');
  });

  test('contextStorage() middleware adds x-request-id response header', async () => {
    const app = new Vajra();
    app.use(contextStorage());
    app.get('/h', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/h', {
      headers: { 'x-request-id': 'custom-456' },
    }));
    expect(res.headers.get('x-request-id')).toBe('custom-456');
  });

  test('hasRequestContext returns false outside a request', () => {
    expect(hasRequestContext()).toBe(false);
    expect(getRequestContext('anything')).toBeUndefined();
  });
});
