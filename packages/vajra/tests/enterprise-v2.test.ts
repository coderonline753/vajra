import { describe, test, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import {
  contextStorage, getRequestContext, setRequestContext, hasRequestContext,
  createLogger, requestLogger,
  defineConfig,
  createFeatureFlags,
  smartQuery, defineResource, filtersToSQL, serializeRow,
} from '../src';
import { z } from 'zod';

/* ═══════ ASYNC LOCAL STORAGE ═══════ */

describe('Request Context (AsyncLocalStorage)', () => {
  test('traceId propagates through async chain', async () => {
    const app = new Vajra();
    app.use(contextStorage());

    let capturedTraceId: string | undefined;
    app.get('/test', async (c) => {
      // Simulate deep async call
      await new Promise(r => setTimeout(r, 1));
      capturedTraceId = getRequestContext<string>('traceId');
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/test'));
    expect(res.status).toBe(200);
    expect(capturedTraceId).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBe(capturedTraceId);
  });

  test('uses incoming x-request-id', async () => {
    const app = new Vajra();
    app.use(contextStorage());
    app.get('/test', (c) => c.json({ traceId: getRequestContext('traceId') }));

    const res = await app.handle(new Request('http://localhost/test', {
      headers: { 'x-request-id': 'custom-123' },
    }));
    const data = await res.json();
    expect(data.traceId).toBe('custom-123');
  });

  test('setRequestContext stores custom data', async () => {
    const app = new Vajra();
    app.use(contextStorage());
    app.use(async (c, next) => {
      setRequestContext('userId', 'user-42');
      return next();
    });
    app.get('/test', (c) => c.json({ userId: getRequestContext('userId') }));

    const res = await app.handle(new Request('http://localhost/test'));
    const data = await res.json();
    expect(data.userId).toBe('user-42');
  });

  test('hasRequestContext returns false outside request', () => {
    expect(hasRequestContext()).toBe(false);
  });

  test('requests have isolated contexts', async () => {
    const app = new Vajra();
    app.use(contextStorage());
    app.get('/test', (c) => {
      setRequestContext('value', Math.random());
      return c.json({ value: getRequestContext('value') });
    });

    const [res1, res2] = await Promise.all([
      app.handle(new Request('http://localhost/test')),
      app.handle(new Request('http://localhost/test')),
    ]);
    const d1 = await res1.json();
    const d2 = await res2.json();
    expect(d1.value).not.toBe(d2.value); // Different contexts
  });
});

/* ═══════ STRUCTURED LOGGER ═══════ */

describe('Structured Logger', () => {
  test('outputs JSON', () => {
    const lines: string[] = [];
    const log = createLogger({ output: (l) => lines.push(l) });
    log.info('test message', { key: 'value' });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.key).toBe('value');
    expect(parsed.ts).toBeTruthy();
  });

  test('respects log level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', output: (l) => lines.push(l) });
    log.debug('hidden');
    log.info('hidden');
    log.warn('visible');
    log.error('visible');
    expect(lines).toHaveLength(2);
  });

  test('child logger inherits meta', () => {
    const lines: string[] = [];
    const log = createLogger({ output: (l) => lines.push(l) });
    const child = log.child({ module: 'auth' });
    child.info('login');

    const parsed = JSON.parse(lines[0]);
    expect(parsed.module).toBe('auth');
    expect(parsed.msg).toBe('login');
  });

  test('request logger middleware works', async () => {
    const lines: string[] = [];
    const log = createLogger({ output: (l) => lines.push(l) });
    const app = new Vajra();
    app.use(requestLogger(log));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.handle(new Request('http://localhost/test'));

    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toContain('GET /test');
    expect(parsed.status).toBe(200);
    expect(parsed.duration).toBeGreaterThanOrEqual(0);
  });
});

/* ═══════ CONFIG SYSTEM ═══════ */

describe('Config System', () => {
  test('reads from env vars', () => {
    process.env.PORT = '4000';
    process.env.DATABASE_URL = 'postgres://localhost/test';

    const config = defineConfig({
      port: z.coerce.number().default(3000),
      database: z.object({
        url: z.string(),
      }),
    });

    expect(config.port).toBe(4000);
    expect(config.database.url).toBe('postgres://localhost/test');

    delete process.env.PORT;
    delete process.env.DATABASE_URL;
  });

  test('uses defaults when env not set', () => {
    const config = defineConfig({
      port: z.coerce.number().default(3000),
      debug: z.coerce.boolean().default(false),
    });

    expect(config.port).toBe(3000);
    expect(config.debug).toBe(false);
  });

  test('throws on missing required vars', () => {
    expect(() => {
      defineConfig({ secret: z.string().min(10) });
    }).toThrow('Validation failed');
  });
});

/* ═══════ FEATURE FLAGS ═══════ */

describe('Feature Flags', () => {
  test('basic flag check', () => {
    const flags = createFeatureFlags({
      'new-checkout': { enabled: true },
      'old-feature': { enabled: false },
    });
    expect(flags.isEnabled('new-checkout')).toBe(true);
    expect(flags.isEnabled('old-feature')).toBe(false);
    expect(flags.isEnabled('nonexistent')).toBe(false);
  });

  test('percentage rollout', () => {
    const flags = createFeatureFlags({
      'experiment': { enabled: true, percentage: 50 },
    });
    // Without userId, percentage rollout returns false
    expect(flags.isEnabled('experiment')).toBe(false);
    // With userId, consistent result
    const result1 = flags.isEnabled('experiment', { userId: 'user-1' });
    const result2 = flags.isEnabled('experiment', { userId: 'user-1' });
    expect(result1).toBe(result2); // Consistent for same user
  });

  test('allow list', () => {
    const flags = createFeatureFlags({
      'beta': { enabled: true, allowList: ['user-1', 'user-2'] },
    });
    expect(flags.isEnabled('beta', { userId: 'user-1' })).toBe(true);
    expect(flags.isEnabled('beta', { userId: 'user-99' })).toBe(false);
  });

  test('deny list', () => {
    const flags = createFeatureFlags({
      'feature': { enabled: true, denyList: ['banned-user'] },
    });
    expect(flags.isEnabled('feature', { userId: 'banned-user' })).toBe(false);
    expect(flags.isEnabled('feature', { userId: 'normal-user' })).toBe(true);
  });

  test('runtime update', () => {
    const flags = createFeatureFlags({ 'feature': { enabled: false } });
    expect(flags.isEnabled('feature')).toBe(false);
    flags.set('feature', { enabled: true });
    expect(flags.isEnabled('feature')).toBe(true);
  });

  test('getAll returns all flags', () => {
    const flags = createFeatureFlags({
      a: { enabled: true },
      b: { enabled: false },
    });
    const all = flags.getAll();
    expect(Object.keys(all)).toHaveLength(2);
  });
});

/* ═══════ SMART QUERY ═══════ */

describe('Smart Query', () => {
  const userResource = defineResource({
    table: 'users',
    fields: {
      id: { selectable: true, hidden: false, defaultSelect: true },
      name: { selectable: true, hidden: false, defaultSelect: true },
      email: { selectable: true, hidden: false, defaultSelect: true },
      password: { selectable: false, hidden: true, defaultSelect: false },
      role: { selectable: true, hidden: false, defaultSelect: true },
      created_at: { selectable: true, hidden: false, defaultSelect: false },
    },
    relations: {
      posts: { table: 'posts', type: 'hasMany', foreignKey: 'author_id', includable: true },
    },
  });

  test('field selection filters by schema', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ fields: sq.fields });
    });

    const res = await app.handle(new Request('http://localhost/users?fields=name,email,password'));
    const data = await res.json();
    expect(data.fields).toContain('name');
    expect(data.fields).toContain('email');
    expect(data.fields).not.toContain('password'); // hidden
  });

  test('default fields when no ?fields param', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ fields: sq.fields });
    });

    const res = await app.handle(new Request('http://localhost/users'));
    const data = await res.json();
    expect(data.fields).toContain('id');
    expect(data.fields).toContain('name');
    expect(data.fields).not.toContain('created_at'); // defaultSelect: false
  });

  test('filters parse correctly', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ filters: sq.filters });
    });

    const res = await app.handle(new Request('http://localhost/users?filter[role]=admin&filter[name][like]=john'));
    const data = await res.json();
    expect(data.filters).toHaveLength(2);
    expect(data.filters[0].field).toBe('role');
    expect(data.filters[0].operator).toBe('eq');
    expect(data.filters[1].operator).toBe('like');
  });

  test('rejects filter on hidden field', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ filters: sq.filters });
    });

    const res = await app.handle(new Request('http://localhost/users?filter[password]=secret'));
    const data = await res.json();
    expect(data.filters).toHaveLength(0);
  });

  test('sort parsing', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ sort: sq.sort });
    });

    const res = await app.handle(new Request('http://localhost/users?sort=-created_at,name'));
    const data = await res.json();
    expect(data.sort[0]).toEqual({ column: 'created_at', direction: 'DESC' });
    expect(data.sort[1]).toEqual({ column: 'name', direction: 'ASC' });
  });

  test('pagination defaults', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ page: sq.page, pageSize: sq.pageSize });
    });

    const res = await app.handle(new Request('http://localhost/users'));
    const data = await res.json();
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(25);
  });

  test('pagination clamps max', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource, maxPageSize: 50 }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ pageSize: sq.pageSize });
    });

    const res = await app.handle(new Request('http://localhost/users?per_page=9999'));
    const data = await res.json();
    expect(data.pageSize).toBe(50);
  });

  test('include parses valid relations', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ includes: sq.includes });
    });

    const res = await app.handle(new Request('http://localhost/users?include=posts'));
    const data = await res.json();
    expect(data.includes).toHaveLength(1);
    expect(data.includes[0].path).toBe('posts');
  });

  test('include rejects invalid relations', async () => {
    const app = new Vajra();
    app.get('/users', smartQuery({ resource: userResource }), (c) => {
      const sq = c.get<any>('smartQuery');
      return c.json({ includes: sq.includes });
    });

    const res = await app.handle(new Request('http://localhost/users?include=secrets'));
    const data = await res.json();
    expect(data.includes).toHaveLength(0);
  });

  test('filtersToSQL generates safe parameterized SQL', () => {
    const result = filtersToSQL([
      { field: 'role', operator: 'eq', value: 'admin' },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
    expect(result.clause).toBe('"role" = ? AND "age" >= ?');
    expect(result.values).toEqual(['admin', 18]);
  });

  test('filtersToSQL handles IN operator', () => {
    const result = filtersToSQL([
      { field: 'status', operator: 'in', value: ['active', 'pending'] },
    ]);
    expect(result.clause).toBe('"status" IN (?, ?)');
    expect(result.values).toEqual(['active', 'pending']);
  });

  test('serializeRow strips hidden fields', () => {
    const row = { id: 1, name: 'Test', email: 'test@t.com', password: 'secret123' };
    const serialized = serializeRow(row, userResource);
    expect(serialized.name).toBe('Test');
    expect(serialized).not.toHaveProperty('password');
  });
});
