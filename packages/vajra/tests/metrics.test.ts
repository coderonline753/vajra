import { describe, test, expect } from 'bun:test';
import {
  createCounter,
  createGauge,
  createHistogram,
  createRegistry,
  createMetrics,
} from '../src/metrics';
import { Context } from '../src/context';

/* ═════════════ COUNTER ═════════════ */

describe('Counter', () => {
  test('starts at zero and increments', () => {
    const c = createCounter({ name: 'c1', help: 'test' });
    expect(c.collect()).toEqual([]);
    c.inc();
    expect(c.collect()[0]!.value).toBe(1);
    c.inc({}, 4);
    expect(c.collect()[0]!.value).toBe(5);
  });

  test('rejects negative increments', () => {
    const c = createCounter({ name: 'c2', help: 'x' });
    expect(() => c.inc({}, -1)).toThrow(/cannot decrement/);
  });

  test('tracks labels separately', () => {
    const c = createCounter({ name: 'c3', help: '', labelNames: ['status'] });
    c.inc({ status: '200' });
    c.inc({ status: '200' });
    c.inc({ status: '500' });
    const samples = c.collect();
    const s200 = samples.find((s) => s.labels.status === '200')!;
    const s500 = samples.find((s) => s.labels.status === '500')!;
    expect(s200.value).toBe(2);
    expect(s500.value).toBe(1);
  });

  test('reset clears all values', () => {
    const c = createCounter({ name: 'c4', help: '' });
    c.inc();
    c.reset();
    expect(c.collect()).toEqual([]);
  });
});

/* ═════════════ GAUGE ═════════════ */

describe('Gauge', () => {
  test('set, inc, dec', () => {
    const g = createGauge({ name: 'g1', help: '' });
    g.set(10);
    expect(g.collect()[0]!.value).toBe(10);
    g.inc(5);
    expect(g.collect()[0]!.value).toBe(15);
    g.dec(3);
    expect(g.collect()[0]!.value).toBe(12);
  });

  test('labels isolated', () => {
    const g = createGauge({ name: 'g2', help: '', labelNames: ['type'] });
    g.set(1, { type: 'a' });
    g.set(2, { type: 'b' });
    expect(g.collect()).toHaveLength(2);
  });
});

/* ═════════════ HISTOGRAM ═════════════ */

describe('Histogram', () => {
  test('observations land in buckets', () => {
    const h = createHistogram({
      name: 'h1',
      help: '',
      buckets: [0.1, 0.5, 1, 5],
    });
    h.observe(0.05);
    h.observe(0.3);
    h.observe(2);

    const samples = h.collect();
    const buckets = samples.filter((s) => s.name === 'h1_bucket');
    const sum = samples.find((s) => s.name === 'h1_sum')!;
    const count = samples.find((s) => s.name === 'h1_count')!;

    // 0.05 → buckets 0.1, 0.5, 1, 5 (all four ≥ 0.05)
    // 0.3 → buckets 0.5, 1, 5
    // 2 → buckets 5
    expect(buckets.find((b) => b.labels.le === '0.1')!.value).toBe(1);
    expect(buckets.find((b) => b.labels.le === '0.5')!.value).toBe(2);
    expect(buckets.find((b) => b.labels.le === '1')!.value).toBe(2);
    expect(buckets.find((b) => b.labels.le === '5')!.value).toBe(3);
    expect(buckets.find((b) => b.labels.le === '+Inf')!.value).toBe(3);
    expect(count.value).toBe(3);
    expect(sum.value).toBeCloseTo(2.35, 5);
  });

  test('startTimer measures elapsed', async () => {
    const h = createHistogram({ name: 'h2', help: '' });
    const stop = h.startTimer();
    await new Promise((r) => setTimeout(r, 30));
    const elapsed = stop();
    expect(elapsed).toBeGreaterThan(0.02);
    expect(elapsed).toBeLessThan(0.5);
  });

  test('rejects non-increasing buckets', () => {
    expect(() => createHistogram({ name: 'bad', help: '', buckets: [1, 0.5] })).toThrow();
  });
});

/* ═════════════ REGISTRY ═════════════ */

describe('Registry', () => {
  test('prevents duplicate metric names', () => {
    const r = createRegistry();
    r.counter({ name: 'dup', help: '' });
    expect(() => r.counter({ name: 'dup', help: '' })).toThrow(/already registered/);
  });

  test('render produces Prometheus format', () => {
    const r = createRegistry();
    const c = r.counter({ name: 'reqs', help: 'req count', labelNames: ['status'] });
    c.inc({ status: '200' });
    c.inc({ status: '500' });

    const output = r.render();
    expect(output).toContain('# HELP reqs req count');
    expect(output).toContain('# TYPE reqs counter');
    expect(output).toContain('reqs{status="200"} 1');
    expect(output).toContain('reqs{status="500"} 1');
  });

  test('render escapes quotes and backslashes in label values', () => {
    const r = createRegistry();
    const c = r.counter({ name: 'escape', help: 'plain help text', labelNames: ['msg'] });
    c.inc({ msg: 'hello "world"' });
    const output = r.render();
    // Label values escape quotes: msg="hello \"world\""
    expect(output).toContain('msg="hello \\"world\\""');
  });

  test('resetAll clears counters', () => {
    const r = createRegistry();
    const c = r.counter({ name: 'x', help: '' });
    c.inc();
    r.resetAll();
    expect(c.collect()).toEqual([]);
  });
});

/* ═════════════ HTTP MIDDLEWARE BUNDLE ═════════════ */

describe('createMetrics', () => {
  test('middleware records requests', async () => {
    const m = createMetrics({ defaultMetrics: false });
    const mw = m.middleware();

    const ctx = new Context(new Request('http://localhost/api/users'));
    await mw(ctx, async () => {
      ctx.set('__metrics_status', 200);
    });

    const samples = m.httpRequests.collect();
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBe(1);
    expect(samples[0]!.labels.route).toBe('/api/users');
    expect(samples[0]!.labels.status).toBe('200');
  });

  test('records duration histogram', async () => {
    const m = createMetrics({ defaultMetrics: false });
    const mw = m.middleware();
    const ctx = new Context(new Request('http://localhost/x'));
    await mw(ctx, async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const samples = m.httpDuration.collect();
    const count = samples.find((s) => s.name === 'http_request_duration_seconds_count')!;
    expect(count.value).toBe(1);
  });

  test('in-flight gauge tracks active', async () => {
    const m = createMetrics({ defaultMetrics: false });
    const mw = m.middleware();
    let midFlight = -1;
    const ctx = new Context(new Request('http://localhost/'));
    await mw(ctx, async () => {
      midFlight = m.httpInFlight.collect()[0]!.value;
    });
    expect(midFlight).toBe(1);
    expect(m.httpInFlight.collect()[0]!.value).toBe(0);
  });

  test('/metrics handler returns exposition', async () => {
    const m = createMetrics({ defaultMetrics: false });
    m.httpRequests.inc({ method: 'GET', route: '/', status: '200' });

    const ctx = new Context(new Request('http://localhost/metrics'));
    const response = await m.handler()(ctx);
    expect(response).toBeInstanceOf(Response);
    const text = await (response as Response).text();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('route="/"');
  });

  test('defaultMetrics adds process metrics', () => {
    const m = createMetrics({ defaultMetrics: true });
    const output = m.registry.render();
    expect(output).toContain('process_memory_rss_bytes');
    expect(output).toContain('process_uptime_seconds');
  });

  test('records 500 when handler throws', async () => {
    const m = createMetrics({ defaultMetrics: false });
    const mw = m.middleware();
    const ctx = new Context(new Request('http://localhost/boom'));
    try {
      await mw(ctx, async () => { throw new Error('x'); });
    } catch { /* expected */ }
    const samples = m.httpRequests.collect();
    expect(samples[0]!.labels.status).toBe('500');
  });

  test('custom routeLabel groups dynamic routes', async () => {
    const m = createMetrics({
      defaultMetrics: false,
      routeLabel: () => '/users/:id',
    });
    const mw = m.middleware();
    await mw(new Context(new Request('http://localhost/users/42')), async () => {});
    await mw(new Context(new Request('http://localhost/users/99')), async () => {});
    const samples = m.httpRequests.collect();
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBe(2);
    expect(samples[0]!.labels.route).toBe('/users/:id');
  });
});
