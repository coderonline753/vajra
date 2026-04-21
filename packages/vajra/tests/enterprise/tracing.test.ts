import { describe, it, expect } from 'bun:test';
import { Vajra, tracing, createSpan } from '../../src/index';

describe('Tracing Middleware', () => {
  it('adds trace headers to response', async () => {
    const app = new Vajra();
    app.use(tracing());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-trace-id')).toBeTruthy();
    expect(res.headers.get('x-span-id')).toBeTruthy();
    expect(res.headers.get('x-trace-id')!.length).toBe(32);
    expect(res.headers.get('x-span-id')!.length).toBe(16);
  });

  it('stores traceId in context', async () => {
    const app = new Vajra();
    app.use(tracing());
    app.get('/', (c) => {
      return c.json({ traceId: c.get('traceId'), spanId: c.get('spanId') });
    });

    const res = await app.handle(new Request('http://localhost/'));
    const data = await res.json() as any;
    expect(data.traceId).toBeTruthy();
    expect(data.spanId).toBeTruthy();
  });

  it('propagates incoming trace context', async () => {
    const app = new Vajra();
    app.use(tracing());
    app.get('/', (c) => c.json({ traceId: c.get('traceId') }));

    const incomingTraceId = 'a'.repeat(32);
    const res = await app.handle(new Request('http://localhost/', {
      headers: { traceparent: `00-${incomingTraceId}-${'b'.repeat(16)}-01` },
    }));

    const data = await res.json() as any;
    expect(data.traceId).toBe(incomingTraceId);
  });

  it('onSpan callback receives span data', async () => {
    let capturedSpan: any = null;
    const app = new Vajra();
    app.use(tracing({
      serviceName: 'my-api',
      onSpan: (span) => { capturedSpan = span; },
    }));
    app.get('/users', (c) => c.json({ users: [] }));

    await app.handle(new Request('http://localhost/users'));

    expect(capturedSpan).not.toBeNull();
    expect(capturedSpan.name).toBe('GET /users');
    expect(capturedSpan.kind).toBe('SERVER');
    expect(capturedSpan.status).toBe('OK');
    expect(capturedSpan.duration).toBeGreaterThan(0);
    expect(capturedSpan.attributes['service.name']).toBe('my-api');
    expect(capturedSpan.attributes['http.method']).toBe('GET');
    expect(capturedSpan.attributes['http.status_code']).toBe(200);
  });

  it('sampling rate skips traces', async () => {
    let spanCount = 0;
    const app = new Vajra();
    app.use(tracing({ sampleRate: 0, onSpan: () => spanCount++ }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 10; i++) {
      await app.handle(new Request('http://localhost/'));
    }

    expect(spanCount).toBe(0);
  });
});

describe('createSpan', () => {
  it('creates child span with timing', () => {
    const { span, end } = createSpan('db.query', 'trace123', 'parent456', 'CLIENT');
    expect(span.name).toBe('db.query');
    expect(span.kind).toBe('CLIENT');
    expect(span.traceId).toBe('trace123');
    expect(span.parentSpanId).toBe('parent456');

    const completed = end('OK', { 'db.statement': 'SELECT 1' });
    expect(completed.status).toBe('OK');
    expect(completed.duration).toBeGreaterThanOrEqual(0);
    expect(completed.attributes['db.statement']).toBe('SELECT 1');
  });
});
