/**
 * Vajra — Main Application Class
 * Indestructible. Lightning Fast.
 */

import { Router } from './router';
import { Context } from './context';
import { VajraError, HttpError } from './errors';
import { compose, composeOptimized, type Handler, type Middleware } from './middleware';
import { WebSocketRouter, type WebSocketHandler, type WebSocketData } from './websocket';
import { PluginRegistry, type PluginDefinition } from './plugin';
import { runWithRequestContext } from './context-storage';

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

interface RouteConfig {
  method: HTTPMethod;
  path: string;
  schema?: {
    body?: unknown;
    params?: unknown;
    query?: unknown;
    headers?: unknown;
  };
  middleware?: Middleware[];
  handler: Handler;
}

interface GroupCallback {
  (group: RouteGroup): void;
}

export interface VajraOptions {
  maxBodySize?: number;
  requestTimeout?: number;
  /**
   * Enable the v1.2 optimized request path:
   *   - Register-time middleware chain flattening (drops the per-request
   *     dispatch function and double-next safety check).
   *   - (v1.2) Request object pooling for reduced GC pressure.
   *
   * Opt-in for v1.2.0. Projects written against v1.0 must follow the
   * stability contract's five user-discipline rules (never hold Context
   * post-response, register middleware before listen, no reliance on
   * microtask ordering, set headers before c.json(), public exports only).
   *
   * Becomes default in v1.2.1 after field validation.
   *
   * @default false
   */
  optimize?: boolean;
}

class RouteGroup {
  private prefix: string;
  private app: Vajra;
  private groupMiddleware: Middleware[];

  constructor(prefix: string, app: Vajra, middleware: Middleware[] = []) {
    this.prefix = prefix;
    this.app = app;
    this.groupMiddleware = middleware;
  }

  get(path: string, ...args: (Middleware | Handler)[]): this {
    this.addRoute('GET', path, args);
    return this;
  }

  post(path: string, ...args: (Middleware | Handler)[]): this {
    this.addRoute('POST', path, args);
    return this;
  }

  put(path: string, ...args: (Middleware | Handler)[]): this {
    this.addRoute('PUT', path, args);
    return this;
  }

  delete(path: string, ...args: (Middleware | Handler)[]): this {
    this.addRoute('DELETE', path, args);
    return this;
  }

  patch(path: string, ...args: (Middleware | Handler)[]): this {
    this.addRoute('PATCH', path, args);
    return this;
  }

  private addRoute(method: HTTPMethod, path: string, args: (Middleware | Handler)[]): void {
    const fullPath = this.prefix + path;
    const handler = args.pop() as Handler;
    const middleware = [...this.groupMiddleware, ...(args as Middleware[])];
    this.app['addRoute'](method, fullPath, handler, middleware);
  }
}

/** Route handler payload stored on the router. `_compiled` is filled lazily
 * on first match under `optimize: true` to cache the merged middleware chain. */
interface RouteEntry {
  handler: Handler;
  middleware: Middleware[];
  _compiled?: Handler;
}

export class Vajra {
  private router = new Router<RouteEntry>();
  private globalMiddleware: Middleware[] = [];
  private options: Required<VajraOptions>;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private wsRouter = new WebSocketRouter();
  private pluginRegistry = new PluginRegistry();
  private decorations = new Map<string, unknown>();

  private notFoundHandler: Handler = (c) => c.json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }, 404);

  private errorHandler: (err: Error, c: Context) => Response = (err, c) => {
    /* VajraError hierarchy — structured response with code, message, details */
    if (err instanceof VajraError) {
      const body = err.toJSON();
      return c.json(body, err.statusCode);
    }

    /* Legacy HttpError support */
    if (err instanceof HttpError) {
      return c.json({
        success: false,
        error: { code: 'HTTP_ERROR', message: err.message },
      }, err.statusCode);
    }

    /* Unknown errors — log full stack, return safe message */
    console.error(`[Vajra Error]`, err);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : err.message,
      },
    }, 500);
  };

  constructor(options: VajraOptions = {}) {
    this.options = {
      maxBodySize: options.maxBodySize ?? 1_048_576,
      requestTimeout: options.requestTimeout ?? 30_000,
      optimize: options.optimize ?? false,
    };
  }

  /** Add global middleware */
  use(middleware: Middleware): this {
    this.globalMiddleware.push(middleware);
    return this;
  }

  /** Register GET route */
  get(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('GET', path, args);
    return this;
  }

  /** Register POST route */
  post(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('POST', path, args);
    return this;
  }

  /** Register PUT route */
  put(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('PUT', path, args);
    return this;
  }

  /** Register DELETE route */
  delete(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('DELETE', path, args);
    return this;
  }

  /** Register PATCH route */
  patch(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('PATCH', path, args);
    return this;
  }

  /** Register HEAD route */
  head(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('HEAD', path, args);
    return this;
  }

  /** Register OPTIONS route */
  options(path: string, ...args: (Middleware | Handler)[]): this {
    this.registerRoute('OPTIONS', path, args);
    return this;
  }

  /** Register route via object config (structured style) */
  route(config: RouteConfig): this {
    this.addRoute(config.method, config.path, config.handler, config.middleware || []);
    return this;
  }

  /** Create a route group with shared prefix and middleware */
  group(prefix: string, ...args: (Middleware | GroupCallback)[]): this {
    const callback = args.pop() as GroupCallback;
    const middleware = args as Middleware[];
    const group = new RouteGroup(prefix, this, middleware);
    callback(group);
    return this;
  }

  /** Register WebSocket route */
  ws(path: string, handler: WebSocketHandler): this {
    this.wsRouter.add(path, handler);
    return this;
  }

  /** Register SSR page route (defineRoute integration) */
  page(path: string, route: { handle: (c: Context) => Promise<Response> }): this {
    // GET for rendering
    this.addRoute('GET', path, (c) => route.handle(c), []);
    // POST/PUT/DELETE/PATCH for actions
    this.addRoute('POST', path, (c) => route.handle(c), []);
    this.addRoute('PUT', path, (c) => route.handle(c), []);
    this.addRoute('DELETE', path, (c) => route.handle(c), []);
    this.addRoute('PATCH', path, (c) => route.handle(c), []);
    return this;
  }

  /** Register a plugin */
  async plugin<TConfig>(
    definition: PluginDefinition<TConfig>,
    config?: Partial<TConfig>
  ): Promise<this> {
    await this.pluginRegistry.register(this, definition, config);
    return this;
  }

  /** Add a property to the app instance (accessible via app.propertyName) */
  decorate(key: string, value: unknown): this {
    if (this.decorations.has(key)) {
      throw new Error(`[Vajra] Decoration "${key}" already exists`);
    }
    this.decorations.set(key, value);
    (this as unknown as Record<string, unknown>)[key] = value;
    return this;
  }

  /** Add a per-request property to Context (accessible via c.get(key)) */
  decorateContext(key: string, factory: (c: Context) => unknown): this {
    this.use(async (c, next) => {
      c.set(key, factory(c));
      return next();
    });
    return this;
  }

  /** Set custom 404 handler */
  onNotFound(handler: Handler): this {
    this.notFoundHandler = handler;
    return this;
  }

  /** Set custom error handler */
  onError(handler: (err: Error, c: Context) => Response): this {
    this.errorHandler = handler;
    return this;
  }

  /** Handle a raw Request (for testing or custom servers) */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    let match = this.router.match(method, path);

    // HEAD auto-handling: try GET if no explicit HEAD route
    let isHeadRequest = false;
    if (!match && method === 'HEAD') {
      match = this.router.match('GET', path);
      isHeadRequest = true;
    }

    const c = new Context(req, match?.params || {}, url, this.options.maxBodySize);

    // Determine the final handler and middleware stack
    let finalHandler: Handler;
    let routeMiddleware: Middleware[] = [];
    let routeEntry: RouteEntry | null = null;

    if (match) {
      routeEntry = match.handler;
      finalHandler = routeEntry.handler;
      routeMiddleware = routeEntry.middleware;
    } else {
      // Check for 405 Method Not Allowed
      const allowedMethods = this.router.matchPath(path);
      if (allowedMethods.length > 0) {
        finalHandler = () => new Response(null, {
          status: 405,
          headers: { 'allow': allowedMethods.join(', ') },
        });
      } else {
        finalHandler = this.notFoundHandler;
      }
    }

    const optimize = this.options.optimize;
    const composer = optimize ? composeOptimized : compose;

    const executeRequest = async (): Promise<Response> => {
      try {
        // Fast path · use cached compiled chain when available (optimize mode).
        // First match for a route pays the compose cost once; subsequent
        // requests reuse the closed-over handler with no per-request array
        // spread or composer call.
        if (optimize && routeEntry) {
          let compiled = routeEntry._compiled;
          if (!compiled) {
            if (this.globalMiddleware.length === 0 && routeMiddleware.length === 0) {
              compiled = finalHandler;
            } else {
              // Build the merged chain once and keep it.
              const merged: Middleware[] = [];
              for (const mw of this.globalMiddleware) merged.push(mw);
              for (const mw of routeMiddleware) merged.push(mw);
              compiled = composer(merged, finalHandler);
            }
            routeEntry._compiled = compiled;
          }
          return await compiled(c);
        }

        // Non-optimize path · per-request composition (preserves legacy
        // behavior, lets users dynamically add globalMiddleware even after
        // the server started).
        if (this.globalMiddleware.length === 0 && routeMiddleware.length === 0) {
          return await finalHandler(c);
        }
        const allMiddleware = [...this.globalMiddleware, ...routeMiddleware];
        const composed = composer(allMiddleware, finalHandler);
        return await composed(c);
      } catch (err) {
        return this.errorHandler(err instanceof Error ? err : new Error(String(err)), c);
      }
    };

    let response: Response;
    const timeout = this.options.requestTimeout;

    // Auto-wrap every request in an AsyncLocalStorage context so
    // getRequestContext() / setRequestContext() work without any explicit
    // middleware. Eliminates the silent cross-request data-leak footgun
    // when a concurrent service forgot to install contextStorage().
    const runAll = () => {
      if (timeout <= 0) return executeRequest();
      return Promise.race([
        executeRequest(),
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('Request Timeout', { status: 408 })), timeout)
        ),
      ]);
    };

    response = await runWithRequestContext(c, runAll);

    // HEAD: return headers only, no body
    if (isHeadRequest) {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  }

  /** Start the server */
  listen(port = 3000, callback?: () => void): void {
    const self = this;
    const wsHandlers = this.wsRouter.getHandlers();
    const hasWs = this.wsRouter['routes'].length > 0;

    const serveConfig: Parameters<typeof Bun.serve<WebSocketData>>[0] = {
      port,
      async fetch(req, server) {
        // WebSocket upgrade with auth hook
        if (hasWs && req.headers.get('upgrade') === 'websocket') {
          const result = await self.wsRouter.handleUpgrade(req, server);
          if (result) return result; // 403 or 400
          if (!result) return undefined as unknown as Response; // Upgraded
        }
        return self.handle(req);
      },
    };

    if (hasWs) {
      serveConfig.websocket = {
        ...wsHandlers,
        maxPayloadLength: self.wsRouter.maxPayloadLength,
        idleTimeout: self.wsRouter.idleTimeout,
      };
    }

    this.server = Bun.serve<WebSocketData>(serveConfig);

    // Graceful shutdown with connection drain
    const shutdown = async () => {
      console.log('\n  Vajra: graceful shutdown...');

      // Stop accepting new connections, finish in-flight requests
      this.server?.stop(true);

      // Shutdown plugins (close DB connections, Redis, etc.)
      await this.pluginRegistry.shutdown(this);

      // Max drain timeout 30s
      const drainTimeout = setTimeout(() => {
        console.log('  Vajra: force shutdown (drain timeout)');
        process.exit(1);
      }, 30_000);
      if (drainTimeout.unref) drainTimeout.unref();

      console.log('  Vajra: shutdown complete');
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    if (callback) {
      callback();
    } else {
      console.log(`\n  Vajra running on http://localhost:${port}\n`);
    }
  }

  /** Stop the server programmatically */
  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  /** Internal: register route from shorthand */
  private registerRoute(method: HTTPMethod, path: string, args: (Middleware | Handler)[]): void {
    const handler = args.pop() as Handler;
    const middleware = args as Middleware[];
    this.addRoute(method, path, handler, middleware);
  }

  /** Internal: add route to router */
  private addRoute(method: HTTPMethod, path: string, handler: Handler, middleware: Middleware[]): void {
    this.router.add(method, path, { handler, middleware });
  }
}
