import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
  defineContract,
  createClient,
  contractRouter,
  ClientError,
} from '../src/contract';
import { Context } from '../src/context';

/* ═════════════ DEFINE CONTRACT ═════════════ */

describe('defineContract', () => {
  test('returns contract unchanged', () => {
    const c = defineContract({
      ping: { method: 'GET', path: '/ping' },
    });
    expect(c.ping.method).toBe('GET');
  });
});

/* ═════════════ CLIENT ═════════════ */

describe('createClient', () => {
  const contract = defineContract({
    createUser: {
      method: 'POST',
      path: '/users',
      body: z.object({ name: z.string(), email: z.string().email() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
    getUser: {
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
    listUsers: {
      method: 'GET',
      path: '/users',
      query: z.object({ limit: z.number().optional() }),
      response: z.array(z.object({ id: z.string() })),
    },
    ping: {
      method: 'GET',
      path: '/ping',
      response: z.object({ ok: z.boolean() }),
    },
  });

  function mockFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
    return ((req: Request | string, init?: RequestInit) => {
      const finalReq = req instanceof Request ? req : new Request(req, init);
      return Promise.resolve(handler(finalReq));
    }) as typeof fetch;
  }

  test('POST request with validated body', async () => {
    let capturedReq: Request | null = null;
    const fetch = mockFetch(async (req) => {
      capturedReq = req;
      return new Response(JSON.stringify({ id: '1', name: 'Rahul' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    const result = await client.createUser({ body: { name: 'Rahul', email: 'r@x.com' } });
    expect(result.id).toBe('1');
    expect(result.name).toBe('Rahul');
    expect(capturedReq!.method).toBe('POST');
    expect(capturedReq!.url).toBe('https://api.x.com/users');
  });

  test('GET with path params substituted', async () => {
    let capturedReq: Request | null = null;
    const fetch = mockFetch(async (req) => {
      capturedReq = req;
      return new Response(JSON.stringify({ id: '42', name: 'Priya' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    await client.getUser({ params: { id: '42' } });
    expect(capturedReq!.url).toBe('https://api.x.com/users/42');
  });

  test('GET with query params', async () => {
    let capturedUrl = '';
    const fetch = mockFetch(async (req) => {
      capturedUrl = req.url;
      return new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    await client.listUsers({ query: { limit: 10 } });
    expect(capturedUrl).toContain('limit=10');
  });

  test('GET without input works', async () => {
    const fetch = mockFetch(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    const result = await client.ping(undefined);
    expect(result.ok).toBe(true);
  });

  test('rejects on non-2xx with ClientError', async () => {
    const fetch = mockFetch(async () => new Response('Server error', { status: 500 }));
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    try {
      await client.ping(undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      expect((err as ClientError).status).toBe(500);
    }
  });

  test('response schema validates data', async () => {
    const fetch = mockFetch(async () => {
      // Return invalid shape — response schema expects ok:boolean
      return new Response(JSON.stringify({ ok: 'yes' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch });
    expect(client.ping(undefined)).rejects.toThrow();
  });

  test('unsafeSkipValidation bypasses response schema', async () => {
    const fetch = mockFetch(async () => {
      return new Response(JSON.stringify({ ok: 'yes' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch, unsafeSkipValidation: true });
    const result = await client.ping(undefined);
    expect((result as any).ok).toBe('yes');
  });

  test('deprecated skipValidation still works and warns', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(String(msg)); };
    try {
      const fetch = mockFetch(async () => new Response(JSON.stringify({ ok: 'yes' }), {
        headers: { 'content-type': 'application/json' },
      }));
      const client = createClient(contract, { baseUrl: 'https://api.x.com', fetch, skipValidation: true });
      const result = await client.ping(undefined);
      expect((result as any).ok).toBe('yes');
      expect(warnings.some(w => w.includes('deprecated') && w.includes('unsafeSkipValidation'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test('common headers passed on every request', async () => {
    let captured: Request | null = null;
    const fetch = mockFetch(async (req) => {
      captured = req;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, {
      baseUrl: 'https://api.x.com',
      fetch,
      headers: { authorization: 'Bearer TOKEN' },
    });
    await client.ping(undefined);
    expect(captured!.headers.get('authorization')).toBe('Bearer TOKEN');
  });

  test('async headers function', async () => {
    let captured: Request | null = null;
    const fetch = mockFetch(async (req) => {
      captured = req;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(contract, {
      baseUrl: 'https://api.x.com',
      fetch,
      headers: async () => ({ 'x-trace': 'abc' }),
    });
    await client.ping(undefined);
    expect(captured!.headers.get('x-trace')).toBe('abc');
  });

  test('beforeRequest + afterResponse hooks', async () => {
    const fetch = mockFetch(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    let before = false;
    let after = false;
    const client = createClient(contract, {
      baseUrl: 'https://api.x.com',
      fetch,
      beforeRequest: (req) => { before = true; return req; },
      afterResponse: (res) => { after = true; return res; },
    });
    await client.ping(undefined);
    expect(before).toBe(true);
    expect(after).toBe(true);
  });
});

/* ═════════════ SERVER BINDING ═════════════ */

describe('contractRouter', () => {
  const contract = defineContract({
    createUser: {
      method: 'POST',
      path: '/users',
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
    getUser: {
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
  });

  test('returns route descriptors with handlers', () => {
    const routes = contractRouter(contract, {
      createUser: async ({ body }) => ({ id: '1', name: body.name }),
      getUser: async ({ params }) => ({ id: params.id, name: 'Alice' }),
    });

    expect(routes).toHaveLength(2);
    expect(routes[0]!.method).toBe('POST');
    expect(routes[1]!.path).toBe('/users/:id');
  });

  test('handler receives parsed body', async () => {
    const routes = contractRouter(contract, {
      createUser: async ({ body }) => ({ id: '1', name: body.name }),
      getUser: async ({ params }) => ({ id: params.id, name: 'x' }),
    });

    const create = routes.find((r) => r.method === 'POST')!;
    const req = new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ravi' }),
    });
    const ctx = new Context(req);
    const response = await create.handler(ctx);
    const data = await (response as Response).json();
    expect(data.name).toBe('Ravi');
  });

  test('handler receives parsed params', async () => {
    const routes = contractRouter(contract, {
      createUser: async ({ body }) => ({ id: '1', name: body.name }),
      getUser: async ({ params }) => ({ id: params.id, name: 'Nisha' }),
    });

    const get = routes.find((r) => r.method === 'GET')!;
    const req = new Request('http://localhost/users/7');
    const ctx = new Context(req, { id: '7' });
    const response = await get.handler(ctx);
    const data = await (response as Response).json();
    expect(data.id).toBe('7');
  });

  test('rejects invalid body via Zod', async () => {
    const routes = contractRouter(contract, {
      createUser: async ({ body }) => ({ id: '1', name: body.name }),
      getUser: async ({ params }) => ({ id: params.id, name: 'x' }),
    });

    const create = routes.find((r) => r.method === 'POST')!;
    const req = new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // missing name
    });
    const ctx = new Context(req);
    expect(create.handler(ctx)).rejects.toThrow();
  });
});
