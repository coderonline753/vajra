import { describe, test, expect } from 'bun:test';
import { Vajra, compose, composeOptimized, cors, type Middleware, type Handler } from '../src/index';
import { Context } from '../src/context';

/* ═══════ Behavior parity: compose vs composeOptimized ═══════ */

describe('Behavior parity · compose vs composeOptimized', () => {
  function makeCtx(method = 'GET'): Context {
    return new Context(new Request('http://localhost/x', { method }));
  }

  test('empty middleware list calls handler directly (both composers)', async () => {
    const fh: Handler = (c) => c.text('ok');
    const safe = compose([], fh);
    const fast = composeOptimized([], fh);
    const r1 = await safe(makeCtx());
    const r2 = await fast(makeCtx());
    expect(await r1.text()).toBe('ok');
    expect(await r2.text()).toBe('ok');
  });

  test('single middleware that sets header has identical output', async () => {
    const mw: Middleware = async (c, next) => {
      const res = await next();
      res.headers.set('x-custom', '1');
      return res;
    };
    const fh: Handler = (c) => c.json({ n: 1 });
    const r1 = await compose([mw], fh)(makeCtx());
    const r2 = await composeOptimized([mw], fh)(makeCtx());
    expect(r1.status).toBe(r2.status);
    expect(r1.headers.get('x-custom')).toBe(r2.headers.get('x-custom'));
    expect(await r1.text()).toBe(await r2.text());
  });

  test('four-layer stack matches (helmet-like + cors-like + timer + auth)', async () => {
    const order: string[] = [];
    const m1: Middleware = async (c, next) => {
      order.push('m1-before');
      const r = await next();
      r.headers.set('x-m1', 'after');
      order.push('m1-after');
      return r;
    };
    const m2: Middleware = async (c, next) => {
      order.push('m2-before');
      const r = await next();
      r.headers.set('x-m2', 'after');
      order.push('m2-after');
      return r;
    };
    const m3: Middleware = async (c, next) => {
      c.set('user', { id: 1 });
      return next();
    };
    const m4: Middleware = async (c, next) => {
      order.push('m4-before');
      return next();
    };
    const fh: Handler = (c) => {
      const user = c.get('user');
      return c.json({ user });
    };

    order.length = 0;
    const r1 = await compose([m1, m2, m3, m4], fh)(makeCtx());
    const safeOrder = [...order];

    order.length = 0;
    const r2 = await composeOptimized([m1, m2, m3, m4], fh)(makeCtx());
    const fastOrder = [...order];

    expect(safeOrder).toEqual(fastOrder);
    expect(r1.status).toBe(r2.status);
    expect(r1.headers.get('x-m1')).toBe(r2.headers.get('x-m1'));
    expect(r1.headers.get('x-m2')).toBe(r2.headers.get('x-m2'));
    expect(await r1.text()).toBe(await r2.text());
  });

  test('middleware that short-circuits (returns without calling next) matches', async () => {
    const guard: Middleware = (c) => c.json({ blocked: true }, 403);
    const handler: Handler = (c) => c.text('never');
    const r1 = await compose([guard], handler)(makeCtx());
    const r2 = await composeOptimized([guard], handler)(makeCtx());
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(await r1.text()).toBe(await r2.text());
  });

  test('sync middleware that returns Response directly (no await) matches', async () => {
    const sync: Middleware = (c, next) => next();
    const fh: Handler = (c) => c.text('sync-ok');
    const r1 = await compose([sync, sync], fh)(makeCtx());
    const r2 = await composeOptimized([sync, sync], fh)(makeCtx());
    expect(await r1.text()).toBe(await r2.text());
  });
});

/* ═══════ End-to-end: Vajra with optimize flag ═══════ */

describe('Vajra { optimize: true } end-to-end', () => {
  test('same response shape with and without optimize', async () => {
    async function run(optimize: boolean) {
      const app = new Vajra({ optimize });
      app.use(cors({ origin: '*' }));
      app.use(async (c, next) => {
        const r = await next();
        r.headers.set('x-stack', 'vajra');
        return r;
      });
      app.get('/hello/:name', (c) => c.json({ hello: c.param('name') }));
      const res = await app.handle(new Request('http://localhost/hello/world'));
      return {
        status: res.status,
        body: await res.text(),
        xStack: res.headers.get('x-stack'),
        contentType: res.headers.get('content-type'),
        allowOrigin: res.headers.get('access-control-allow-origin'),
      };
    }
    const safe = await run(false);
    const fast = await run(true);
    expect(fast).toEqual(safe);
  });

  test('error handler fires identically with optimize on', async () => {
    async function run(optimize: boolean) {
      const app = new Vajra({ optimize });
      app.get('/boom', () => { throw new Error('x'); });
      const res = await app.handle(new Request('http://localhost/boom'));
      return { status: res.status, body: await res.text() };
    }
    const safe = await run(false);
    const fast = await run(true);
    expect(fast.status).toBe(safe.status);
    expect(fast.body).toBe(safe.body);
  });

  test('double-next throws on safe compose, silently re-enters on optimize', async () => {
    async function run(optimize: boolean) {
      const app = new Vajra({ optimize });
      let calls = 0;
      app.use(async (c, next) => {
        calls++;
        await next();
        await next(); // intentional double-next
        return new Response('wrapper', { status: 200 });
      });
      app.get('/x', (c) => c.text('handler'));
      const res = await app.handle(new Request('http://localhost/x'));
      return { status: res.status, calls };
    }

    const safe = await run(false);
    const fast = await run(true);

    // Safe compose: error handler catches 'next() called multiple times', returns 500
    expect(safe.status).toBe(500);

    // Optimize: silently re-enters handler, returns the wrapper body
    // (documents the trade-off, not a defect)
    expect(fast.status).toBe(200);
  });

  test('empty middleware stack uses direct handler path in both modes', async () => {
    async function run(optimize: boolean) {
      const app = new Vajra({ optimize });
      app.get('/x', (c) => c.text('direct'));
      const res = await app.handle(new Request('http://localhost/x'));
      return await res.text();
    }
    expect(await run(false)).toBe('direct');
    expect(await run(true)).toBe('direct');
  });
});
