import { describe, it, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import { Context } from '../src/context';

describe('JS Quirk Safety', () => {
  it('handles null body gracefully', async () => {
    const app = new Vajra();
    app.post('/data', async (c) => {
      const body = await c.body();
      return c.json({ type: typeof body, value: body });
    });

    const res = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    }));

    const data = await res.json() as any;
    expect(data.value).toBeNull();
  });

  it('handles undefined query param without crash', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    expect(c.query('nonexistent')).toBeNull();
    expect(c.param('nonexistent')).toBe('');
  });

  it('handles empty JSON body', async () => {
    const app = new Vajra();
    app.post('/empty', async (c) => {
      const body = await c.body();
      return c.json({ body });
    });

    const res = await app.handle(new Request('http://localhost/empty', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));

    const data = await res.json() as any;
    expect(data.body).toEqual({});
  });

  it('handles array as JSON body', async () => {
    const app = new Vajra();
    app.post('/arr', async (c) => {
      const body = await c.body();
      return c.json({ body });
    });

    const res = await app.handle(new Request('http://localhost/arr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]',
    }));

    const data = await res.json() as any;
    expect(data.body).toEqual([1, 2, 3]);
  });

  it('c.get returns undefined not null for missing keys', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    expect(c.get('missing')).toBeUndefined();
    expect(c.get('missing') === undefined).toBe(true);
    expect(c.get('missing') === null).toBe(false);
  });

  it('param with numeric value stays string', async () => {
    const app = new Vajra();
    app.get('/users/:id', (c) => {
      const id = c.param('id');
      return c.json({ id, type: typeof id });
    });

    const res = await app.handle(new Request('http://localhost/users/42'));
    const data = await res.json() as any;
    expect(data.type).toBe('string');
    expect(data.id).toBe('42');
  });

  it('handles special JSON values (0, false, empty string)', async () => {
    const app = new Vajra();
    app.get('/zero', (c) => c.json({ val: 0 }));
    app.get('/false', (c) => c.json({ val: false }));
    app.get('/empty', (c) => c.json({ val: '' }));

    const r1 = await app.handle(new Request('http://localhost/zero'));
    expect((await r1.json() as any).val).toBe(0);

    const r2 = await app.handle(new Request('http://localhost/false'));
    expect((await r2.json() as any).val).toBe(false);

    const r3 = await app.handle(new Request('http://localhost/empty'));
    expect((await r3.json() as any).val).toBe('');
  });

  it('handles prototype pollution attempt in body', async () => {
    const app = new Vajra();
    app.post('/data', async (c) => {
      const body = await c.body<any>();
      // __proto__ should not pollute Object prototype
      return c.json({ hasProto: '__proto__' in body, constructor: typeof body.constructor });
    });

    const res = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"__proto__": {"polluted": true}, "normal": "data"}',
    }));

    // Verify global Object is not polluted
    expect(({} as any).polluted).toBeUndefined();
  });

  it('handles very long URL without crash', async () => {
    const app = new Vajra();
    app.get('/search', (c) => c.json({ q: c.query('q')?.length }));

    const longQuery = 'a'.repeat(8000);
    const res = await app.handle(new Request(`http://localhost/search?q=${longQuery}`));
    const data = await res.json() as any;
    expect(data.q).toBe(8000);
  });

  it('handles unicode in route params', async () => {
    const app = new Vajra();
    app.get('/users/:name', (c) => c.json({ name: c.param('name') }));

    const res = await app.handle(new Request('http://localhost/users/%E0%A4%B5%E0%A4%9C%E0%A5%8D%E0%A4%B0'));
    const data = await res.json() as any;
    expect(data.name).toBe('वज्र'); // auto-decoded from URL encoding
  });

  it('body is parsed only once (cached)', async () => {
    const app = new Vajra();
    app.post('/double', async (c) => {
      const b1 = await c.body<any>();
      const b2 = await c.body<any>();
      return c.json({ same: b1 === b2, name: b1.name });
    });

    const res = await app.handle(new Request('http://localhost/double', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"vajra"}',
    }));

    const data = await res.json() as any;
    expect(data.same).toBe(true);
    expect(data.name).toBe('vajra');
  });

  it('multiple set/get on context works', () => {
    const req = new Request('http://localhost/');
    const c = new Context(req);

    c.set('a', 1);
    c.set('b', 'two');
    c.set('c', { nested: true });
    c.set('a', 99); // overwrite

    expect(c.get('a')).toBe(99);
    expect(c.get('b')).toBe('two');
    expect(c.get<{ nested: boolean }>('c')?.nested).toBe(true);
  });
});
