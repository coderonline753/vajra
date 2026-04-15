/**
 * Vajra Store — Lightweight reactive store for inter-island state
 * Similar to Nano Stores but built-in. Works across isolated island roots.
 *
 * Usage:
 *   const count = atom(0)
 *   count.set(5)
 *   count.subscribe(val => console.log(val))
 *
 *   const doubled = computed(count, val => val * 2)
 *
 *   const todos = map<{ items: string[], filter: string }>({ items: [], filter: 'all' })
 *   todos.setKey('filter', 'active')
 */

type Listener<T> = (value: T, oldValue: T) => void;
type Unsubscribe = () => void;

/* ═══════ ATOM — Single value store ═══════ */

export interface Atom<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: Listener<T>): Unsubscribe;
  notify(): void;
}

export function atom<T>(initialValue: T): Atom<T> {
  let value = initialValue;
  const listeners = new Set<Listener<T>>();

  return {
    get() {
      return value;
    },

    set(newValue: T) {
      const old = value;
      value = newValue;
      for (const listener of listeners) {
        listener(value, old);
      }
    },

    subscribe(listener: Listener<T>): Unsubscribe {
      listeners.add(listener);
      // Call immediately with current value
      listener(value, value);
      return () => listeners.delete(listener);
    },

    notify() {
      for (const listener of listeners) {
        listener(value, value);
      }
    },
  };
}

/* ═══════ COMPUTED — Derived store ═══════ */

export interface Computed<T> {
  get(): T;
  subscribe(listener: Listener<T>): Unsubscribe;
}

export function computed<T, R>(
  source: Atom<T>,
  transform: (value: T) => R
): Computed<R> {
  const derived = atom(transform(source.get()));

  source.subscribe((value) => {
    derived.set(transform(value));
  });

  return {
    get: derived.get,
    subscribe: derived.subscribe,
  };
}

/* Multi-source computed */
export function computedFrom<R>(
  sources: Atom<unknown>[],
  transform: (...values: unknown[]) => R
): Computed<R> {
  const getValues = () => sources.map(s => s.get());
  const derived = atom(transform(...getValues()));

  for (const source of sources) {
    source.subscribe(() => {
      derived.set(transform(...getValues()));
    });
  }

  return {
    get: derived.get,
    subscribe: derived.subscribe,
  };
}

/* ═══════ MAP — Object store with key-level updates ═══════ */

export interface MapStore<T extends Record<string, unknown>> {
  get(): T;
  get<K extends keyof T>(key: K): T[K];
  set(value: T): void;
  setKey<K extends keyof T>(key: K, value: T[K]): void;
  subscribe(listener: Listener<T>): Unsubscribe;
}

export function map<T extends Record<string, unknown>>(initialValue: T): MapStore<T> {
  const store = atom<T>({ ...initialValue });

  return {
    get(key?: keyof T) {
      if (key !== undefined) return store.get()[key];
      return store.get();
    },

    set(value: T) {
      store.set({ ...value });
    },

    setKey<K extends keyof T>(key: K, value: T[K]) {
      const current = store.get();
      store.set({ ...current, [key]: value });
    },

    subscribe: store.subscribe,
  } as MapStore<T>;
}

/* ═══════ ACTION — Named state mutations ═══════ */

export function action<T, Args extends unknown[]>(
  store: Atom<T>,
  mutator: (current: T, ...args: Args) => T
): (...args: Args) => void {
  return (...args: Args) => {
    store.set(mutator(store.get(), ...args));
  };
}

/* ═══════ BATCH — Group multiple updates into one notification ═══════ */

let batchDepth = 0;
let batchQueue: (() => void)[] = [];

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const queue = batchQueue;
      batchQueue = [];
      for (const notify of queue) {
        notify();
      }
    }
  }
}

/* ═══════ SERIALIZE — For SSR hydration ═══════ */

export function serializeStores(stores: Record<string, Atom<unknown>>): string {
  const data: Record<string, unknown> = {};
  for (const [key, store] of Object.entries(stores)) {
    data[key] = store.get();
  }
  return JSON.stringify(data);
}

export function hydrateStores(
  stores: Record<string, Atom<unknown>>,
  serialized: string
): void {
  const data = JSON.parse(serialized);
  for (const [key, store] of Object.entries(stores)) {
    if (key in data) {
      store.set(data[key]);
    }
  }
}
