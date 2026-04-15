/**
 * Vajra RegExp Router
 * Per-method compiled regex with static route O(1) lookup. Fast matching with named params.
 */

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

interface RouteEntry<T = unknown> {
  method: HTTPMethod;
  path: string;
  handler: T;
  paramNames: string[];
  regex: RegExp;
}

interface MatchResult<T = unknown> {
  handler: T;
  params: Record<string, string>;
}

export class Router<T = unknown> {
  private routes: Map<string, RouteEntry<T>[]> = new Map();
  private staticRoutes: Map<string, RouteEntry<T>> = new Map();

  add(method: HTTPMethod, path: string, handler: T): void {
    const paramNames: string[] = [];
    const regex = this.pathToRegex(path, paramNames);
    const entry: RouteEntry<T> = { method, path, handler, paramNames, regex };

    const list = this.routes.get(method) || [];

    // Route conflict detection
    const duplicate = list.find(r => r.path === path);
    if (duplicate) {
      throw new Error(`Route conflict: ${method} ${path} is already registered`);
    }

    list.push(entry);
    this.routes.set(method, list);

    // O(1) static route lookup
    const isStatic = !path.includes(':') && !path.includes('*');
    if (isStatic) {
      this.staticRoutes.set(`${method}:${path}`, entry);
    }
  }

  match(method: string, path: string): MatchResult<T> | null {
    // Fast path: O(1) static route lookup
    const staticEntry = this.staticRoutes.get(`${method}:${path}`);
    if (staticEntry) {
      return { handler: staticEntry.handler, params: {} };
    }

    // Slow path: regex scan for parameterized routes
    const list = this.routes.get(method);
    if (!list) return null;

    for (const route of list) {
      // Skip static routes already checked above
      if (route.paramNames.length === 0 && !route.path.includes('*')) continue;

      const m = route.regex.exec(path);
      if (m) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const raw = m[i + 1] || '';
          try {
            params[route.paramNames[i]] = decodeURIComponent(raw);
          } catch {
            params[route.paramNames[i]] = raw;
          }
        }
        return { handler: route.handler, params };
      }
    }

    return null;
  }

  /** Check if any method has a route matching this path */
  matchPath(path: string): string[] {
    const methods: string[] = [];
    for (const [method, list] of this.routes) {
      // Check static routes first
      if (this.staticRoutes.has(`${method}:${path}`)) {
        methods.push(method);
        continue;
      }
      for (const route of list) {
        if (route.regex.test(path)) {
          methods.push(method);
          break;
        }
      }
    }
    return methods;
  }

  private pathToRegex(path: string, paramNames: string[]): RegExp {
    if (path === '*') {
      paramNames.push('$wildcard');
      return /^(.*)$/;
    }

    let pattern = '';
    const segments = path.split('/');

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === '') {
        if (i === 0) continue; // leading slash
        if (i === segments.length - 1) {
          // Trailing slash: preserve it
          pattern += '\\/';
          continue;
        }
        continue;
      }

      pattern += '\\/';

      if (seg.startsWith(':')) {
        const name = seg.slice(1);
        if (name.endsWith('*')) {
          paramNames.push(name.slice(0, -1));
          pattern += '(.+)';
        } else {
          paramNames.push(name);
          pattern += '([^/]+)';
        }
      } else if (seg === '*') {
        paramNames.push('$wildcard');
        pattern += '(.*)';
      } else {
        pattern += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }

    if (pattern === '') pattern = '\\/';

    return new RegExp(`^${pattern}$`);
  }
}
