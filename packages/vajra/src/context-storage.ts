/**
 * Vajra Request Context Storage
 * AsyncLocalStorage-based context propagation.
 * TraceId, userId, and custom data flow through the entire async call chain.
 *
 * @example
 *   app.use(contextStorage());
 *
 *   // Deep in a service, no `c` reference needed:
 *   import { getRequestContext } from 'vajrajs';
 *   const traceId = getRequestContext('traceId');
 *   const userId = getRequestContext('userId');
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Middleware } from './middleware';
import type { Context } from './context';

type ContextData = Map<string, unknown>;

const storage = new AsyncLocalStorage<ContextData>();

/**
 * Internal · used by Vajra.handle() to wrap every request in ALS automatically.
 * Not exported from the package entry point — user code should not call this.
 */
export function runWithRequestContext<T>(c: Context, fn: () => Promise<T>): Promise<T> {
  // Nested calls reuse the outer store rather than shadow it.
  if (storage.getStore()) return fn();

  const store = new Map<string, unknown>();
  const traceId = c.req.headers.get('x-request-id') || crypto.randomUUID();
  store.set('traceId', traceId);
  store.set('method', c.method);
  store.set('path', c.path);

  return storage.run(store, fn);
}

/**
 * Middleware that guarantees a request-scoped AsyncLocalStorage context is
 * active. As of v1.0.1 the framework already wraps every request, so this
 * middleware is optional — it remains exported so existing code keeps working
 * and so that the x-request-id response header can be emitted without also
 * installing the security/request-id middleware.
 *
 * When installed, it adds the trace id to the response headers. The store
 * itself is shared with whatever Vajra.handle() set up.
 */
export function contextStorage(): Middleware {
  return async (c, next) => {
    // Store is already provisioned by Vajra.handle(); we just emit the header.
    const traceId = getRequestContext<string>('traceId') ?? c.req.headers.get('x-request-id') ?? crypto.randomUUID();
    if (!hasRequestContext()) {
      // Very old integration that bypasses Vajra.handle(). Create one.
      const store = new Map<string, unknown>();
      store.set('traceId', traceId);
      store.set('method', c.method);
      store.set('path', c.path);
      return storage.run(store, async () => {
        const res = await next();
        res.headers.set('x-request-id', traceId);
        return res;
      });
    }
    setRequestContext('traceId', traceId);
    const res = await next();
    res.headers.set('x-request-id', traceId);
    return res;
  };
}

/**
 * Get a value from the current request context.
 * Works ANYWHERE in the async call chain — no `c` reference needed.
 */
export function getRequestContext<T = unknown>(key: string): T | undefined {
  const store = storage.getStore();
  return store?.get(key) as T | undefined;
}

/**
 * Set a value in the current request context.
 * Call from middleware after auth to set userId, role, etc.
 */
export function setRequestContext(key: string, value: unknown): void {
  const store = storage.getStore();
  if (store) store.set(key, value);
}

/**
 * Get all request context data (for logging).
 */
export function getRequestContextAll(): Record<string, unknown> {
  const store = storage.getStore();
  if (!store) return {};
  return Object.fromEntries(store);
}

/**
 * Check if running inside a request context.
 */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined;
}
