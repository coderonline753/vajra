import { describe, test, expect } from 'bun:test';
import {
  createQueue,
  createMemoryStore,
  createRedisStore,
  computeBackoff,
  type RedisQueueClient,
  type Job,
} from '../src/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('computeBackoff', () => {
  test('fixed returns constant delay', () => {
    expect(computeBackoff(1, { type: 'fixed', delay: 500 })).toBe(500);
    expect(computeBackoff(5, { type: 'fixed', delay: 500 })).toBe(500);
  });

  test('exponential grows with attempts (within jitter range)', () => {
    const first = computeBackoff(1, { type: 'exponential', delay: 100 });
    const second = computeBackoff(2, { type: 'exponential', delay: 100 });
    const third = computeBackoff(3, { type: 'exponential', delay: 100 });
    // With 20% jitter, ranges: 80-120, 160-240, 320-480
    expect(first).toBeGreaterThanOrEqual(80);
    expect(first).toBeLessThanOrEqual(120);
    expect(second).toBeGreaterThanOrEqual(160);
    expect(second).toBeLessThanOrEqual(240);
    expect(third).toBeGreaterThanOrEqual(320);
    expect(third).toBeLessThanOrEqual(480);
  });

  test('exponential respects max cap', () => {
    const result = computeBackoff(10, { type: 'exponential', delay: 1000, max: 5000 });
    // 1000 * 2^9 = 512000, but capped at 5000 with ±20% jitter
    expect(result).toBeGreaterThanOrEqual(4000);
    expect(result).toBeLessThanOrEqual(6000);
  });
});

describe('Queue · basic flow', () => {
  test('processes a single job', async () => {
    const q = createQueue<{ n: number }>('test', { autoStart: false });
    let received = 0;
    q.process(async (job) => { received = job.data.n; });
    await q.add({ n: 42 });
    q.start();
    await sleep(100);
    await q.stop();
    expect(received).toBe(42);
  });

  test('processes jobs in priority order', async () => {
    const q = createQueue<string>('prio', { concurrency: 1, autoStart: false });
    const order: string[] = [];
    q.process(async (job) => { order.push(job.data); });

    await q.add('c', { priority: 10 });
    await q.add('a', { priority: 1 });
    await q.add('b', { priority: 5 });

    q.start();
    await sleep(150);
    await q.stop();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('respects concurrency limit', async () => {
    const q = createQueue<number>('conc', { concurrency: 3, autoStart: false });
    let peak = 0;
    let active = 0;
    q.process(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(50);
      active--;
    });

    for (let i = 0; i < 10; i++) await q.add(i);
    q.start();
    await sleep(100);
    expect(peak).toBeLessThanOrEqual(3);
    await q.stop();
  });

  test('delayed job runs after delay', async () => {
    const q = createQueue<string>('delay', { autoStart: false, pollInterval: 25 });
    const startAt = Date.now();
    let runAt = 0;
    q.process(async () => { runAt = Date.now(); });

    await q.add('x', { delay: 200 });
    q.start();

    await sleep(400);
    await q.stop();

    expect(runAt - startAt).toBeGreaterThanOrEqual(190);
    expect(runAt - startAt).toBeLessThan(500);
  });
});

describe('Queue · retries', () => {
  test('retries on failure with backoff', async () => {
    const q = createQueue<number>('retry', {
      autoStart: false,
      retries: 2,
      backoff: { type: 'fixed', delay: 30 },
      pollInterval: 15,
    });
    let attempts = 0;
    q.process(async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
    });

    await q.add(1);
    q.start();
    await sleep(400);
    await q.stop();
    expect(attempts).toBe(3);
  });

  test('marks job failed after retries exhausted', async () => {
    const q = createQueue<number>('fail', {
      autoStart: false,
      retries: 1,
      backoff: { type: 'fixed', delay: 20 },
    });
    const events: string[] = [];
    q.on((e) => {
      if (e.type === 'failed') events.push('failed:' + (e.job as Job).data);
      if (e.type === 'retrying') events.push('retry:' + (e.job as Job).data);
    });
    q.process(async () => { throw new Error('boom'); });

    await q.add(42);
    q.start();
    await sleep(300);
    await q.stop();

    expect(events.filter((e) => e.startsWith('retry:')).length).toBe(1);
    expect(events.filter((e) => e.startsWith('failed:')).length).toBe(1);
  });

  test('emits completed event on success', async () => {
    const q = createQueue<string>('comp', { autoStart: false });
    let completedJobData: string | null = null;
    q.on((e) => {
      if (e.type === 'completed') completedJobData = (e.job as Job<string>).data;
    });
    q.process(async () => {});

    await q.add('hello');
    q.start();
    await sleep(100);
    await q.stop();

    expect(completedJobData).toBe('hello');
  });
});

describe('Queue · control', () => {
  test('size reflects pending jobs', async () => {
    const q = createQueue<number>('size', { autoStart: false });
    q.process(async () => { await sleep(1000); });
    for (let i = 0; i < 5; i++) await q.add(i);
    expect(await q.size()).toBe(5);
  });

  test('clear removes all jobs', async () => {
    const q = createQueue<number>('clr', { autoStart: false });
    q.process(async () => {});
    for (let i = 0; i < 3; i++) await q.add(i);
    expect(await q.size()).toBe(3);
    await q.clear();
    expect(await q.size()).toBe(0);
  });

  test('cannot register two processors', () => {
    const q = createQueue('dup', { autoStart: false });
    q.process(async () => {});
    expect(() => q.process(async () => {})).toThrow(/already has a processor/);
  });

  test('cannot start without processor', () => {
    const q = createQueue('noproc', { autoStart: false });
    expect(() => q.start()).toThrow(/without a processor/);
  });

  test('stop drains active jobs', async () => {
    const q = createQueue<number>('drain', { concurrency: 2, autoStart: false });
    let finished = 0;
    q.process(async () => { await sleep(80); finished++; });

    await q.add(1);
    await q.add(2);
    q.start();
    await sleep(20);
    await q.stop();
    // Both active jobs should complete during drain
    expect(finished).toBe(2);
  });
});

/* ═════════════ REDIS STORE (with fake client) ═════════════ */

function createFakeRedis(): RedisQueueClient {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  const get = (k: string) => {
    let s = sets.get(k);
    if (!s) { s = []; sets.set(k, s); }
    return s;
  };
  return {
    async zadd(key, score, member) {
      const s = get(key);
      // upsert: remove existing member first
      for (let i = 0; i < s.length; i++) {
        if (s[i]!.member === member) { s.splice(i, 1); break; }
      }
      s.push({ score, member });
      s.sort((a, b) => a.score - b.score);
      return 1;
    },
    async zrangebyscore(key, min, max, limit) {
      const s = get(key);
      const minN = min === '-inf' ? -Infinity : Number(min);
      const maxN = max === '+inf' ? Infinity : Number(max);
      const filtered = s.filter((e) => e.score >= minN && e.score <= maxN);
      const start = limit?.offset ?? 0;
      const end = limit ? start + limit.count : filtered.length;
      return filtered.slice(start, end).map((e) => e.member);
    },
    async zrem(key, member) {
      const s = get(key);
      for (let i = 0; i < s.length; i++) {
        if (s[i]!.member === member) { s.splice(i, 1); return 1; }
      }
      return 0;
    },
    async zcard(key) {
      return get(key).length;
    },
    async del(key) {
      sets.delete(key);
      return 1;
    },
  };
}

describe('Queue · Redis store', () => {
  test('integrates with Redis-like client', async () => {
    const redis = createFakeRedis();
    const store = createRedisStore(redis, 'test:');
    const q = createQueue<string>('emails', { store, autoStart: false });

    const got: string[] = [];
    q.process(async (job) => { got.push(job.data); });

    await q.add('first');
    await q.add('second');

    expect(await q.size()).toBe(2);

    q.start();
    await sleep(100);
    await q.stop();

    expect(got).toContain('first');
    expect(got).toContain('second');
  });

  test('Redis store respects delay', async () => {
    const redis = createFakeRedis();
    const store = createRedisStore(redis);
    const q = createQueue<number>('d', { store, autoStart: false, pollInterval: 25 });

    let ran = false;
    q.process(async () => { ran = true; });

    await q.add(1, { delay: 150 });
    q.start();

    // Should not run immediately
    await sleep(50);
    expect(ran).toBe(false);

    await sleep(250);
    await q.stop();
    expect(ran).toBe(true);
  });
});

describe('Queue · memory store helpers', () => {
  test('createMemoryStore is exported', () => {
    const store = createMemoryStore();
    expect(typeof store.push).toBe('function');
    expect(typeof store.popReady).toBe('function');
  });
});
