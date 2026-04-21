/**
 * Vajra Plugin System
 * Simple, typed, with lifecycle hooks and dependency management.
 *
 * Usage:
 *   const myPlugin = definePlugin({
 *     name: 'my-plugin',
 *     register(app, config) { app.decorate('db', createDB(config.url)); },
 *     close(app) { app.db.close(); },
 *   });
 *
 *   app.plugin(myPlugin, { url: 'postgres://...' });
 */

import type { Vajra } from './vajra';
import type { Middleware } from './middleware';
import type { Context } from './context';

export interface PluginDefinition<TConfig = Record<string, unknown>> {
  /** Unique plugin name */
  name: string;
  /** Semver version */
  version?: string;
  /** Default configuration values */
  defaults?: Partial<TConfig>;
  /** Other plugin names that must be registered first */
  dependencies?: string[];
  /** Called during registration. Setup decorators, middleware, routes. */
  register: (app: Vajra, config: TConfig) => Promise<void> | void;
  /** Lifecycle hooks */
  hooks?: {
    onRequest?: Middleware;
    onResponse?: (c: Context, res: Response) => Response | Promise<Response>;
  };
  /** Cleanup on shutdown */
  close?: (app: Vajra) => Promise<void> | void;
}

/**
 * Define a plugin with typed configuration.
 * Returns the definition for use with app.plugin().
 */
export function definePlugin<TConfig = Record<string, unknown>>(
  definition: PluginDefinition<TConfig>
): PluginDefinition<TConfig> {
  return definition;
}

/**
 * Plugin registry for tracking registered plugins.
 * Used internally by Vajra class.
 */
export class PluginRegistry {
  private plugins = new Map<string, PluginDefinition>();
  private closeOrder: string[] = [];

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  async register<TConfig>(
    app: Vajra,
    definition: PluginDefinition<TConfig>,
    config?: Partial<TConfig>
  ): Promise<void> {
    // Duplicate check
    if (this.plugins.has(definition.name)) {
      throw new Error(`[Vajra] Plugin "${definition.name}" is already registered`);
    }

    // Dependency check
    for (const dep of definition.dependencies ?? []) {
      if (!this.plugins.has(dep)) {
        throw new Error(
          `[Vajra] Plugin "${definition.name}" requires "${dep}" to be registered first`
        );
      }
    }

    // Merge config with defaults
    const mergedConfig = { ...definition.defaults, ...config } as TConfig;

    // Register
    await definition.register(app, mergedConfig);

    // Add lifecycle hooks as middleware
    if (definition.hooks?.onRequest) {
      app.use(definition.hooks.onRequest);
    }

    this.plugins.set(definition.name, definition as PluginDefinition);
    this.closeOrder.push(definition.name);
  }

  /** Shutdown all plugins in reverse registration order */
  async shutdown(app: Vajra): Promise<void> {
    const reversed = [...this.closeOrder].reverse();
    for (const name of reversed) {
      const plugin = this.plugins.get(name);
      if (plugin?.close) {
        try {
          await plugin.close(app);
        } catch (err) {
          console.error(`[Vajra] Plugin "${name}" close error:`, err);
        }
      }
    }
  }

  /** List registered plugin names */
  list(): string[] {
    return [...this.plugins.keys()];
  }
}
