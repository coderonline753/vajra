import { describe, it, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import { validate } from '../src/validator';
import { z } from 'zod';

describe('Vajra Edge Cases', () => {
  it('handles concurrent requests independently', async () => {
    const app = new Vajra();
    app.get('/delay/:ms', async (c) => {
      const ms = parseInt(c.param('ms'));
      await new Promise((r) => setTimeout(r, ms));
      return c.json({ delayed: ms });
    });

    const [r1, r2] = await Promise.all([
      app.handle(new Request('http://localhost/delay/10')),
      app.handle(new Request('http://localhost/delay/5')),
    ]);

    expect((await r1.json()).delayed).toBe(10);
    expect((await r2.json()).delayed).toBe(5);
  });

  it('context store is isolated per request', async () => {
    const app = new Vajra();
    app.use(async (c, next) => {
      c.set('reqId', Math.random().toString());
      return next();
    });

    app.get('/', (c) => c.json({ id: c.get('reqId') }));

    const [r1, r2] = await Promise.all([
      app.handle(new Request('http://localhost/')),
      app.handle(new Request('http://localhost/')),
    ]);

    const d1 = await r1.json() as any;
    const d2 = await r2.json() as any;
    expect(d1.id).not.toBe(d2.id);
  });

  it('handles body parsing for form data', async () => {
    const app = new Vajra();
    app.post('/form', async (c) => {
      const body = await c.body<Record<string, string>>();
      return c.json(body);
    });

    const res = await app.handle(new Request('http://localhost/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Vajra&version=1',
    }));

    const data = await res.json() as any;
    expect(data.name).toBe('Vajra');
    expect(data.version).toBe('1');
  });

  it('handles text body', async () => {
    const app = new Vajra();
    app.post('/text', async (c) => {
      const body = await c.body<string>();
      return c.text(`received: ${body}`);
    });

    const res = await app.handle(new Request('http://localhost/text', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello vajra',
    }));

    expect(await res.text()).toBe('received: hello vajra');
  });

  it('SSE response works', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(async ({ send, close }) => {
        send('message', 'hello');
        send('message', 'world');
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message');
    expect(text).toContain('data: hello');
    expect(text).toContain('data: world');
  });

  it('group middleware applies only to group routes', async () => {
    const app = new Vajra();
    let adminMwRan = false;

    const adminMw = async (_c: any, next: any) => {
      adminMwRan = true;
      return next();
    };

    app.get('/', (c) => c.text('home'));
    app.group('/admin', adminMw, (g) => {
      g.get('/dashboard', (c) => c.text('admin dashboard'));
    });

    adminMwRan = false;
    await app.handle(new Request('http://localhost/'));
    expect(adminMwRan).toBe(false);

    adminMwRan = false;
    await app.handle(new Request('http://localhost/admin/dashboard'));
    expect(adminMwRan).toBe(true);
  });

  it('validation rejects invalid body', async () => {
    const app = new Vajra();
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
    });

    app.post('/users', validate({ body: schema }), async (c) => {
      return c.json({ ok: true }, 201);
    });

    // Invalid body
    const res = await app.handle(new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'not-email' }),
    }));

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_FAILED');
    expect(data.error.details).toBeDefined();
  });

  it('validation passes valid body', async () => {
    const app = new Vajra();
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
    });

    app.post('/users', validate({ body: schema }), async (c) => {
      const validated = c.get('validatedBody') as any;
      return c.json({ name: validated.name }, 201);
    });

    const res = await app.handle(new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Arjun', email: 'arjun@vajra.dev' }),
    }));

    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.name).toBe('Arjun');
  });

  it('validation checks params', async () => {
    const app = new Vajra();
    const schema = z.object({ id: z.string().uuid() });

    app.get('/users/:id', validate({ params: schema }), (c) => {
      return c.json({ id: c.param('id') });
    });

    // Invalid UUID
    const r1 = await app.handle(new Request('http://localhost/users/not-uuid'));
    expect(r1.status).toBe(400);

    // Valid UUID
    const r2 = await app.handle(new Request('http://localhost/users/550e8400-e29b-41d4-a716-446655440000'));
    expect(r2.status).toBe(200);
  });

  it('validation checks query params', async () => {
    const app = new Vajra();
    const schema = z.object({ page: z.string().regex(/^\d+$/) });

    app.get('/items', validate({ query: schema }), (c) => {
      return c.json({ page: c.query('page') });
    });

    const r1 = await app.handle(new Request('http://localhost/items?page=abc'));
    expect(r1.status).toBe(400);

    const r2 = await app.handle(new Request('http://localhost/items?page=5'));
    expect(r2.status).toBe(200);
  });

  it('error handler catches async errors', async () => {
    const app = new Vajra();
    app.onError((err, c) => c.json({ msg: err.message }, 500));

    app.get('/async-err', async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('async failure');
    });

    const res = await app.handle(new Request('http://localhost/async-err'));
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.msg).toBe('async failure');
  });

  it('handles non-Error throws', async () => {
    const app = new Vajra();
    app.get('/throw-string', () => {
      throw 'string error';
    });

    const res = await app.handle(new Request('http://localhost/throw-string'));
    expect(res.status).toBe(500);
  });

  it('chained status works with all response types', async () => {
    const app = new Vajra();
    app.get('/created', (c) => c.status(201).json({ ok: true }));
    app.get('/accepted', (c) => c.status(202).text('accepted'));
    app.get('/custom-html', (c) => c.status(200).setHeader('x-custom', 'yes').html('<p>hi</p>'));

    const r1 = await app.handle(new Request('http://localhost/created'));
    expect(r1.status).toBe(201);

    const r2 = await app.handle(new Request('http://localhost/accepted'));
    expect(r2.status).toBe(202);
    expect(await r2.text()).toBe('accepted');

    const r3 = await app.handle(new Request('http://localhost/custom-html'));
    expect(r3.headers.get('x-custom')).toBe('yes');
    expect(r3.headers.get('content-type')).toContain('text/html');
  });
});
