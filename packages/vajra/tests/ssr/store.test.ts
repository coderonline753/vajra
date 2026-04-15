import { describe, test, expect } from 'bun:test';
import { atom, computed, computedFrom, map, action, batch, serializeStores, hydrateStores } from '../../src/ssr/store';

describe('atom', () => {
  test('stores and retrieves value', () => {
    const count = atom(0);
    expect(count.get()).toBe(0);
  });

  test('updates value', () => {
    const count = atom(0);
    count.set(5);
    expect(count.get()).toBe(5);
  });

  test('notifies subscribers on change', () => {
    const count = atom(0);
    const values: number[] = [];
    count.subscribe((val) => values.push(val));
    count.set(1);
    count.set(2);
    // First call is immediate with current value (0), then 1, then 2
    expect(values).toEqual([0, 1, 2]);
  });

  test('unsubscribes correctly', () => {
    const count = atom(0);
    const values: number[] = [];
    const unsub = count.subscribe((val) => values.push(val));
    count.set(1);
    unsub();
    count.set(2);
    expect(values).toEqual([0, 1]); // 2 should not appear
  });

  test('works with objects', () => {
    const user = atom({ name: 'Vajra', role: 'admin' });
    user.set({ name: 'Updated', role: 'user' });
    expect(user.get().name).toBe('Updated');
  });
});

describe('computed', () => {
  test('derives value from source', () => {
    const count = atom(5);
    const doubled = computed(count, v => v * 2);
    expect(doubled.get()).toBe(10);
  });

  test('updates when source changes', () => {
    const count = atom(3);
    const doubled = computed(count, v => v * 2);
    count.set(7);
    expect(doubled.get()).toBe(14);
  });

  test('notifies subscribers', () => {
    const count = atom(1);
    const doubled = computed(count, v => v * 2);
    const values: number[] = [];
    doubled.subscribe(val => values.push(val));
    count.set(5);
    expect(values).toEqual([2, 10]);
  });
});

describe('computedFrom (multi-source)', () => {
  test('derives from multiple sources', () => {
    const a = atom(2);
    const b = atom(3);
    const sum = computedFrom([a, b], (x, y) => (x as number) + (y as number));
    expect(sum.get()).toBe(5);
  });

  test('updates when any source changes', () => {
    const a = atom(1);
    const b = atom(2);
    const sum = computedFrom([a, b], (x, y) => (x as number) + (y as number));
    a.set(10);
    expect(sum.get()).toBe(12);
    b.set(20);
    expect(sum.get()).toBe(30);
  });
});

describe('map', () => {
  test('stores object value', () => {
    const store = map({ items: ['a'], filter: 'all' });
    expect(store.get().items).toEqual(['a']);
    expect(store.get().filter).toBe('all');
  });

  test('updates single key', () => {
    const store = map({ items: ['a'], filter: 'all' });
    store.setKey('filter', 'active');
    expect(store.get().filter).toBe('active');
    expect(store.get().items).toEqual(['a']); // unchanged
  });

  test('replaces entire value', () => {
    const store = map({ x: 1, y: 2 });
    store.set({ x: 10, y: 20 });
    expect(store.get()).toEqual({ x: 10, y: 20 });
  });

  test('notifies on key change', () => {
    const store = map({ count: 0 });
    const values: number[] = [];
    store.subscribe(val => values.push(val.count));
    store.setKey('count', 5);
    expect(values).toEqual([0, 5]);
  });
});

describe('action', () => {
  test('creates named mutation', () => {
    const count = atom(0);
    const increment = action(count, (current, amount: number) => current + amount);
    increment(5);
    expect(count.get()).toBe(5);
    increment(3);
    expect(count.get()).toBe(8);
  });
});

describe('serializeStores / hydrateStores', () => {
  test('serializes store values to JSON', () => {
    const count = atom(42);
    const name = atom('Vajra');
    const json = serializeStores({ count, name });
    expect(JSON.parse(json)).toEqual({ count: 42, name: 'Vajra' });
  });

  test('hydrates stores from serialized data', () => {
    const count = atom(0);
    const name = atom('');
    hydrateStores({ count, name }, '{"count":99,"name":"Hydrated"}');
    expect(count.get()).toBe(99);
    expect(name.get()).toBe('Hydrated');
  });
});
