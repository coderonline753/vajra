/**
 * Vajra Module System
 * defineModule() with typed public APIs. Same code runs as monolith or microservices.
 * Dev: all modules in single process. Prod: modules become separate services via config.
 */

import type { Handler, Middleware } from '../middleware';

export interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  middleware?: Middleware[];
  handler: Handler;
}

export interface ModuleAction<TInput = unknown, TOutput = unknown> {
  name: string;
  handler: (input: TInput) => Promise<TOutput>;
}

export interface ModuleDefinition {
  name: string;
  prefix?: string;
  routes?: ModuleRoute[];
  actions?: ModuleAction[];
  middleware?: Middleware[];
  dependencies?: string[];
  onInit?: () => Promise<void> | void;
  onDestroy?: () => Promise<void> | void;
}

export interface Module {
  name: string;
  prefix: string;
  routes: ModuleRoute[];
  actions: Map<string, ModuleAction>;
  middleware: Middleware[];
  dependencies: string[];
  initialized: boolean;
  init(): Promise<void>;
  destroy(): Promise<void>;
  call<TInput, TOutput>(action: string, input: TInput): Promise<TOutput>;
}

export function defineModule(definition: ModuleDefinition): Module {
  const actions = new Map<string, ModuleAction>();
  for (const action of definition.actions ?? []) {
    actions.set(action.name, action);
  }

  const module: Module = {
    name: definition.name,
    prefix: definition.prefix ?? `/${definition.name}`,
    routes: definition.routes ?? [],
    actions,
    middleware: definition.middleware ?? [],
    dependencies: definition.dependencies ?? [],
    initialized: false,

    async init() {
      if (this.initialized) return;
      await definition.onInit?.();
      this.initialized = true;
    },

    async destroy() {
      if (!this.initialized) return;
      await definition.onDestroy?.();
      this.initialized = false;
    },

    async call<TInput, TOutput>(actionName: string, input: TInput): Promise<TOutput> {
      const action = this.actions.get(actionName);
      if (!action) {
        throw new Error(`Module '${this.name}' has no action '${actionName}'`);
      }
      return action.handler(input) as Promise<TOutput>;
    },
  };

  return module;
}

/**
 * Module Registry — manages all modules, handles initialization order,
 * resolves dependencies, registers routes on the app.
 */
export class ModuleRegistry {
  private modules = new Map<string, Module>();
  private initialized = false;

  /** Register a module */
  register(module: Module): this {
    if (this.modules.has(module.name)) {
      throw new Error(`Module '${module.name}' is already registered`);
    }
    this.modules.set(module.name, module);
    return this;
  }

  /** Get a registered module */
  get(name: string): Module | undefined {
    return this.modules.get(name);
  }

  /** Call an action on a module */
  async call<TInput, TOutput>(moduleName: string, action: string, input: TInput): Promise<TOutput> {
    const module = this.modules.get(moduleName);
    if (!module) {
      throw new Error(`Module '${moduleName}' not found`);
    }
    return module.call<TInput, TOutput>(action, input);
  }

  /** Initialize all modules in dependency order */
  async initAll(): Promise<void> {
    if (this.initialized) return;

    // Topological sort for dependency order
    const order = this.resolveDependencyOrder();

    for (const name of order) {
      const module = this.modules.get(name)!;
      await module.init();
    }

    this.initialized = true;
  }

  /** Destroy all modules in reverse order */
  async destroyAll(): Promise<void> {
    if (!this.initialized) return;

    const order = this.resolveDependencyOrder();
    for (const name of order.reverse()) {
      const module = this.modules.get(name)!;
      await module.destroy();
    }

    this.initialized = false;
  }

  /** Register all module routes on a Vajra app */
  mountRoutes(app: {
    get: (path: string, ...args: (Middleware | Handler)[]) => unknown;
    post: (path: string, ...args: (Middleware | Handler)[]) => unknown;
    put: (path: string, ...args: (Middleware | Handler)[]) => unknown;
    delete: (path: string, ...args: (Middleware | Handler)[]) => unknown;
    patch: (path: string, ...args: (Middleware | Handler)[]) => unknown;
  }): void {
    for (const module of this.modules.values()) {
      for (const route of module.routes) {
        const fullPath = module.prefix + route.path;
        const allMiddleware = [...module.middleware, ...(route.middleware ?? [])];
        const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';

        if (allMiddleware.length > 0) {
          (app[method] as Function)(fullPath, ...allMiddleware, route.handler);
        } else {
          (app[method] as Function)(fullPath, route.handler);
        }
      }
    }
  }

  /** Get all registered module names */
  get names(): string[] {
    return [...this.modules.keys()];
  }

  /** Get module count */
  get size(): number {
    return this.modules.size;
  }

  private resolveDependencyOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving module '${name}'`);
      }

      visiting.add(name);
      const module = this.modules.get(name);
      if (!module) {
        throw new Error(`Dependency '${name}' not found`);
      }

      for (const dep of module.dependencies) {
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.modules.keys()) {
      visit(name);
    }

    return order;
  }
}
