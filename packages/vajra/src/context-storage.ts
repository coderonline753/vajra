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

type ContextData = Map<string, unknown>;

const storage = new AsyncLocalStorage<ContextData>();

/**
 * Middleware that wraps each request in AsyncLocalStorage context.
 * Automatically sets traceId. Additional data can be set via setRequestContext().
 */
export function contextStorage(): Middleware {
  return async (c, next) => {
    const store = new Map<string, unknown>();

    // Auto-set traceId
    const traceId = c.req.headers.get('x-request-id') || crypto.randomUUID();
    store.set('traceId', traceId);

    // Auto-set method and path
    store.set('method', c.method);
    store.set('path', c.path);

    // Run request in async context
    return storage.run(store, async () => {
      const res = await next();
      res.headers.set('x-request-id', traceId);
      return res;
    });
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
