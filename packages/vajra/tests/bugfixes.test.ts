import { describe, it, expect } from 'bun:test';
import { Vajra, Context, HttpError, cors, validate } from '../src/index';
import { Router } from '../src/router';
import { z } from 'zod';

describe('Bug Fixes: Router', () => {
  it('trailing slash route matches correctly', () => {
    const r = new Router<string>();
    r.add('GET', '/faq/', 'faq');
    r.add('GET', '/about', 'about');

    expect(r.match('GET', '/faq/')?.handler).toBe('faq');
    expect(r.match('GET', '/faq')).toBeNull();
    expect(r.match('GET', '/about')?.handler).toBe('about');
    expect(r.match('GET', '/about/')).toBeNull();
  });

  it('auto-decodes URL params', () => {
    const r = new Router<string>();
    r.add('GET', '/search/:q', 'search');

    expect(r.match('GET', '/search/hello%20world')?.params.q).toBe('hello world');
    expect(r.match('GET', '/search/%E0%A4%B5%E0%A4%9C%E0%A5%8D%E0%A4%B0')?.params.q).toBe('वज्र');
  });

  it('handles malformed URL encoding gracefully', () => {
    const r = new Router<string>();
    r.add('GET', '/users/:name', 'user');

    const m = r.match('GET', '/users/%ZZbad');
    expect(m).not.toBeNull();
    expect(m?.params.name).toBe('%ZZbad');
  });

  it('throws on duplicate route registration', () => {
    const r = new Router<string>();
    r.add('GET', '/users', 'handler1');

    expect(() => r.add('GET', '/users', 'handler2')).toThrow('Route conflict');
  });

  it('allows same path with different methods', () => {
    const r = new Router<string>();
    r.add('GET', '/users', 'get');
    r.add('POST', '/users', 'post');

    expect(r.match('GET', '/users')?.handler).toBe('get');
    expect(r.match('POST', '/users')?.handler).toBe('post');
  });

  it('static route O(1) lookup works', () => {
    const r = new Router<number>();
    for (let i = 0; i < 100; i++) {
      r.add('GET', `/route${i}`, i);
    }
    r.add('GET', '/dynamic/:id', -1);

    expect(r.match('GET', '/route0')?.handler).toBe(0);
    expect(r.match('GET', '/route50')?.handler).toBe(50);
    expect(r.match('GET', '/route99')?.handler).toBe(99);
    expect(r.match('GET', '/dynamic/42')?.handler).toBe(-1);
  });

  it('matchPath returns methods for matching path', () => {
    const r = new Router<string>();
    r.add('GET', '/users', 'get');
    r.add('POST', '/users', 'post');
    r.add('DELETE', '/users/:id', 'delete');

    const methods = r.matchPath('/users');
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(r.matchPath('/nothing')).toEqual([]);
  });
});

describe('Bug Fixes: HTTP Semantics', () => {
  it('returns 405 with Allow header for wrong method', async () => {
    const app = new Vajra();
    app.get('/users', (c) => c.json({ users: [] }));
    app.post('/users', (c) => c.json({ created: true }));

    const res = await app.handle(new Request('http://localhost/users', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow');
    expect(allow).toContain('GET');
    expect(allow).toContain('POST');
  });

  it('HEAD auto-responds for GET routes', async () => {
    const app = new Vajra();
    app.get('/data', (c) => c.json({ big: 'payload' }));

    const res = await app.handle(new Request('http://localhost/data', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('explicit HEAD route takes priority over GET fallback', async () => {
    const app = new Vajra();
    app.get('/info', (c) => c.json({ data: 'full' }));
    app.head('/info', (c) => c.empty(200));

    const res = await app.handle(new Request('http://localhost/info', { method: 'HEAD' }));
    expect(res.status).toBe(200);
  });

  it('HEAD to non-existent path returns 404', async () => {
    const app = new Vajra();
    app.get('/exists', (c) => c.text('yes'));

    const res = await app.handle(new Request('http://localhost/nope', { method: 'HEAD' }));
    expect(res.status).toBe(404);
  });
});

describe('Bug Fixes: Context', () => {
  it('headers are isolated between responses', async () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);

    c.setHeader('x-first', 'yes');
    const res1 = c.json({ a: 1 });

    c.setHeader('x-second', 'yes');
    const res2 = c.json({ b: 2 });

    expect(res1.headers.get('x-first')).toBe('yes');
    expect(res1.headers.has('x-second')).toBe(false);
    expect(res2.headers.get('x-second')).toBe('yes');
  });

  it('redirect preserves custom headers', async () => {
    const req = new Request('http://localhost/old');
    const c = new Context(req);
    c.setHeader('x-redirect-reason', 'moved');
    const res = c.redirect('/new');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/new');
    expect(res.headers.get('x-redirect-reason')).toBe('moved');
  });

  it('queryAll returns all values for duplicate keys', () => {
    const req = new Request('http://localhost/search?tag=a&tag=b&tag=c');
    const c = new Context(req);

    expect(c.queryAll('tag')).toEqual(['a', 'b', 'c']);
    expect(c.queriesAll).toEqual({ tag: ['a', 'b', 'c'] });
    expect(c.queries.tag).toBe('c'); // backward compat: last value wins
  });

  it('URL is not parsed twice when passed', () => {
    const req = new Request('http://localhost/test?q=vajra');
    const url = new URL(req.url);
    const c = new Context(req, {}, url);

    expect(c.path).toBe('/test');
    expect(c.query('q')).toBe('vajra');
  });

  it('SSE works with async callback', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(async ({ send, close }) => {
        await new Promise((r) => setTimeout(r, 5));
        send('msg', 'delayed');
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events'));
    const text = await res.text();
    expect(text).toContain('event: msg');
    expect(text).toContain('data: delayed');
  });
});

describe('Bug Fixes: Body Handling', () => {
  it('invalid JSON returns 400 not 500', async () => {
    const app = new Vajra();
    app.post('/data', async (c) => {
      const body = await c.body();
      return c.json({ body });
    });

    const res = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json!!}',
    }));

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error.code).toBeDefined();
  });

  it('body size limit returns 413', async () => {
    const app = new Vajra({ maxBodySize: 100 });
    app.post('/upload', async (c) => {
      const body = await c.body();
      return c.json({ body });
    });

    const res = await app.handle(new Request('http://localhost/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '500',
      },
      body: JSON.stringify({ data: 'a'.repeat(400) }),
    }));

    expect(res.status).toBe(413);
  });

  it('FormData is converted to plain object', async () => {
    const app = new Vajra();
    app.post('/form', async (c) => {
      const body = await c.body<Record<string, unknown>>();
      return c.json({ name: body.name, type: typeof body.name });
    });

    const formData = new FormData();
    formData.append('name', 'vajra');
    formData.append('version', '1');

    const res = await app.handle(new Request('http://localhost/form', {
      method: 'POST',
      body: formData,
    }));

    const data = await res.json() as any;
    expect(data.name).toBe('vajra');
    expect(data.type).toBe('string');
  });

  it('HttpError class works correctly', () => {
    const err = new HttpError(404, 'Not Found');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not Found');
    expect(err.name).toBe('HttpError');
    expect(err instanceof Error).toBe(true);
  });
});

describe('Bug Fixes: CORS', () => {
  it('wildcard + credentials reflects request origin', async () => {
    const app = new Vajra();
    app.use(cors({ origin: '*', credentials: true }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com' },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('wildcard without credentials sends *', async () => {
    const app = new Vajra();
    app.use(cors({ origin: '*' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { origin: 'https://example.com' },
    }));

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('Bug Fixes: Validator', () => {
  it('stores validated params in context', async () => {
    const app = new Vajra();
    const schema = z.object({ id: z.string().transform(Number) });

    app.get('/users/:id', validate({ params: schema }), (c) => {
      const validated = c.get('validatedParams') as any;
      return c.json({ id: validated.id, type: typeof validated.id });
    });

    const res = await app.handle(new Request('http://localhost/users/42'));
    const data = await res.json() as any;
    expect(data.id).toBe(42);
    expect(data.type).toBe('number');
  });

  it('stores validated query in context', async () => {
    const app = new Vajra();
    const schema = z.object({ page: z.string().regex(/^\d+$/) });

    app.get('/items', validate({ query: schema }), (c) => {
      const validated = c.get('validatedQuery') as any;
      return c.json({ page: validated.page });
    });

    const res = await app.handle(new Request('http://localhost/items?page=5'));
    const data = await res.json() as any;
    expect(data.page).toBe('5');
  });
});

describe('Bug Fixes: Server', () => {
  it('request timeout returns 408', async () => {
    const app = new Vajra({ requestTimeout: 50 });
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 200));
      return c.text('done');
    });

    const res = await app.handle(new Request('http://localhost/slow'));
    expect(res.status).toBe(408);
  });

  it('fast request completes within timeout', async () => {
    const app = new Vajra({ requestTimeout: 500 });
    app.get('/fast', (c) => c.text('quick'));

    const res = await app.handle(new Request('http://localhost/fast'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('quick');
  });

  it('stop() method exists and does not crash', () => {
    const app = new Vajra();
    expect(typeof app.stop).toBe('function');
    app.stop(); // should not throw when no server running
  });

  it('VajraOptions defaults are applied', async () => {
    const app = new Vajra();
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
  });

  it('global middleware runs on 404/405 routes', async () => {
    const app = new Vajra();
    let mwRan = false;

    app.use(async (_c, next) => {
      mwRan = true;
      return next();
    });

    app.get('/exists', (c) => c.text('ok'));

    mwRan = false;
    await app.handle(new Request('http://localhost/nope'));
    expect(mwRan).toBe(true);

    mwRan = false;
    await app.handle(new Request('http://localhost/exists', { method: 'DELETE' }));
    expect(mwRan).toBe(true);
  });
});
