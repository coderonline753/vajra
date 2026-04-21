/**
 * Vajra Hot Reload State Preservation
 * Bun --watch restarts the whole process. Use stable resources (DB pools, Redis connections,
 * in-memory caches) stored on globalThis so they survive module re-evaluation within the same
 * process when the loader re-imports a file.
 *
 * const pool = preserve('pg-pool', () => createPostgresPool({ ... }));
 * const cache = preserve('req-cache', () => new Map<string, unknown>());
 *
 * Shutdown handlers auto-wire on process signals.
 */

/* ═════════════ GLOBAL REGISTRY ═════════════ */

const REGISTRY_KEY = '__vajra_hot_reload_registry__';

interface Entry<T = unknown> {
  value: T;
  dispose?: (value: T) => void | Promise<void>;
  /** Version token so re-import with same key doesn't error */
  version: string;
  createdAt: number;
}

interface Registry {
  entries: Map<string, Entry>;
  shutdownRegistered: boolean;
  shuttingDown: boolean;
}

function registry(): Registry {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = {
      entries: new Map(),
      shutdownRegistered: false,
      shuttingDown: false,
    };
  }
  return g[REGISTRY_KEY]!;
}

/* ═════════════ PRESERVE ═════════════ */

export interface PreserveOptions<T> {
  /** Optional dispose callback called on shutdown */
  dispose?: (value: T) => void | Promise<void>;
  /** If true, replace existing entry even if already present. Default: false */
  replace?: boolean;
}

export function preserve<T>(key: string, factory: () => T, options: PreserveOptions<T> = {}): T {
  const r = registry();
  const existing = r.entries.get(key);

  if (existing && !options.replace) {
    return existing.value as T;
  }

  if (existing && options.replace && existing.dispose) {
    try {
      const result = existing.dispose(existing.value);
      if (result instanceof Promise) result.catch(() => { /* best effort on replace */ });
    } catch { /* best effort */ }
  }

  const value = factory();
  r.entries.set(key, {
    value,
    dispose: options.dispose as ((value: unknown) => void | Promise<void>) | undefined,
    version: randomVersion(),
    createdAt: Date.now(),
  });

  ensureShutdownHook();
  return value;
}

/**
 * Check if a preserved value exists without creating one.
 */
export function peek<T>(key: string): T | undefined {
  const entry = registry().entries.get(key);
  return entry ? (entry.value as T) : undefined;
}

/**
 * Remove a preserved value and dispose it (best-effort).
 */
export async function release(key: string): Promise<void> {
  const r = registry();
  const entry = r.entries.get(key);
  if (!entry) return;
  r.entries.delete(key);
  if (entry.dispose) {
    await Promise.resolve(entry.dispose(entry.value)).catch(() => { /* best effort */ });
  }
}

/**
 * Return metadata about preserved entries (for debugging).
 */
export function listPreserved(): Array<{ key: string; version: string; createdAt: number }> {
  const r = registry();
  return [...r.entries.entries()].map(([key, entry]) => ({
    key,
    version: entry.version,
    createdAt: entry.createdAt,
  }));
}

/**
 * Dispose everything — used for tests or forced reloads.
 */
export async function disposeAll(): Promise<void> {
  const r = registry();
  const entries = [...r.entries.entries()];
  r.entries.clear();
  for (const [, entry] of entries) {
    if (entry.dispose) {
      try { await Promise.resolve(entry.dispose(entry.value)); } catch { /* ignore */ }
    }
  }
}

function randomVersion(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/* ═════════════ SHUTDOWN HOOK ═════════════ */

function ensureShutdownHook(): void {
  const r = registry();
  if (r.shutdownRegistered) return;
  r.shutdownRegistered = true;

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onShutdown = async () => {
    if (r.shuttingDown) return;
    r.shuttingDown = true;
    await disposeAll();
  };

  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    for (const sig of signals) {
      try { process.on(sig, onShutdown); } catch { /* ignore */ }
    }
    try { process.on('beforeExit', onShutdown); } catch { /* ignore */ }
  }
}

/* ═════════════ UTILITIES ═════════════ */

/**
 * Singleton pattern wrapper — same as preserve() but with a cleaner name for app-level use.
 */
export const singleton = preserve;

/**
 * Warn if we detect a known dev-only pattern: creating a DB pool in a handler (which would leak
 * on every reload). This is a heuristic hint for developers.
 */
export function assertInModuleScope(context: string): void {
  if (typeof process === 'undefined') return;
  if (process.env.NODE_ENV === 'production') return;
  // Best-effort heuristic — detecting "module scope" reliably across bundlers is fragile.
  // Log a hint if many preserve() calls happen in quick succession.
  const r = registry();
  const lastSecond = Date.now() - 1000;
  const recent = [...r.entries.values()].filter((e) => e.createdAt > lastSecond);
  if (recent.length > 20) {
    console.warn(`[vajra/hot-reload] More than 20 preserve() calls in 1 second (${context}). ` +
      'This often means preserve() is being called inside a request handler instead of module scope.');
  }
}
