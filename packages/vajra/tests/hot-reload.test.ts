import { describe, test, expect, beforeEach } from 'bun:test';
import {
  preserve,
  peek,
  release,
  disposeAll,
  listPreserved,
  singleton,
} from '../src/hot-reload';

beforeEach(async () => {
  await disposeAll();
});

describe('preserve', () => {
  test('calls factory on first use', () => {
    let calls = 0;
    const val = preserve('counter', () => { calls++; return { count: 0 }; });
    expect(val.count).toBe(0);
    expect(calls).toBe(1);
  });

  test('returns same instance on subsequent calls with same key', () => {
    const v1 = preserve('same', () => ({ id: Math.random() }));
    const v2 = preserve('same', () => ({ id: Math.random() }));
    expect(v1).toBe(v2);
  });

  test('factory is NOT called when entry exists', () => {
    let calls = 0;
    preserve('x', () => { calls++; return {}; });
    preserve('x', () => { calls++; return {}; });
    preserve('x', () => { calls++; return {}; });
    expect(calls).toBe(1);
  });

  test('replace=true swaps the stored value', async () => {
    preserve('swap', () => ({ tag: 'old' }));
    const next = preserve('swap', () => ({ tag: 'new' }), { replace: true });
    expect(next.tag).toBe('new');
    expect(peek<{ tag: string }>('swap')?.tag).toBe('new');
  });

  test('dispose runs on replace', async () => {
    let disposed = false;
    preserve('disp', () => ({ n: 1 }), {
      dispose: () => { disposed = true; },
    });
    preserve('disp', () => ({ n: 2 }), { replace: true });
    expect(disposed).toBe(true);
  });
});

describe('peek', () => {
  test('returns undefined for missing key', () => {
    expect(peek('nope')).toBeUndefined();
  });

  test('returns value for existing key without running factory', () => {
    preserve('present', () => ({ data: 'yes' }));
    expect(peek<{ data: string }>('present')?.data).toBe('yes');
  });
});

describe('release', () => {
  test('removes entry and calls dispose', async () => {
    let disposeCount = 0;
    preserve('conn', () => ({ fd: 42 }), {
      dispose: () => { disposeCount++; },
    });
    await release('conn');
    expect(peek('conn')).toBeUndefined();
    expect(disposeCount).toBe(1);
  });

  test('release on missing key is silent', async () => {
    await release('ghost');
    expect(peek('ghost')).toBeUndefined();
  });

  test('async dispose works', async () => {
    let done = false;
    preserve('adj', () => ({}), {
      dispose: async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      },
    });
    await release('adj');
    expect(done).toBe(true);
  });
});

describe('listPreserved', () => {
  test('lists all preserved entries', () => {
    preserve('a', () => ({}));
    preserve('b', () => ({}));
    preserve('c', () => ({}));
    const list = listPreserved();
    const keys = list.map((e) => e.key).sort();
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).toContain('c');
  });

  test('metadata includes createdAt and version', () => {
    preserve('meta', () => ({}));
    const entry = listPreserved().find((e) => e.key === 'meta')!;
    expect(typeof entry.version).toBe('string');
    expect(typeof entry.createdAt).toBe('number');
  });
});

describe('disposeAll', () => {
  test('clears all entries and runs dispose', async () => {
    let disposed = 0;
    preserve('x1', () => 1, { dispose: () => { disposed++; } });
    preserve('x2', () => 2, { dispose: () => { disposed++; } });
    preserve('x3', () => 3);

    await disposeAll();

    expect(listPreserved()).toHaveLength(0);
    expect(disposed).toBe(2);
  });

  test('dispose errors do not block', async () => {
    preserve('bad', () => ({}), {
      dispose: () => { throw new Error('boom'); },
    });
    preserve('good', () => ({}), { dispose: () => {} });

    // Should not throw
    await disposeAll();
    expect(listPreserved()).toHaveLength(0);
  });
});

describe('singleton alias', () => {
  test('is the same as preserve', () => {
    expect(singleton).toBe(preserve);
  });

  test('works identically', () => {
    const a = singleton('sing', () => ({ n: 1 }));
    const b = singleton('sing', () => ({ n: 999 }));
    expect(a).toBe(b);
    expect(a.n).toBe(1);
  });
});

/* ═════════════ SIMULATED HOT RELOAD SCENARIO ═════════════ */

describe('hot reload simulation', () => {
  test('preserved value survives multiple factory re-calls', () => {
    // Simulate module re-evaluation: factory called again, same key
    const dbFactory = () => ({
      pool: Symbol('pool'),
      createdAt: Date.now(),
    });

    const first = preserve('db', dbFactory);
    const secondAttempt = preserve('db', dbFactory);
    const thirdAttempt = preserve('db', dbFactory);

    expect(first.pool).toBe(secondAttempt.pool);
    expect(first.pool).toBe(thirdAttempt.pool);
    expect(first.createdAt).toBe(thirdAttempt.createdAt);
  });

  test('replace=true forces fresh instance (simulates explicit refresh)', async () => {
    const original = preserve('fresh', () => ({ ts: 1 }));
    const reloaded = preserve('fresh', () => ({ ts: 2 }), { replace: true });
    expect(original).not.toBe(reloaded);
    expect(reloaded.ts).toBe(2);
  });
});
