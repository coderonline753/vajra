/**
 * Vajra Islands
 * Server renders everything. Islands are explicitly interactive.
 * Each island ships JS only for itself, hydrated on demand.
 *
 * Usage:
 *   const Counter = island('Counter', CounterComponent, { hydrate: 'visible' })
 *
 * Hydration strategies:
 *   'load'    — hydrate on page load (default)
 *   'visible' — hydrate when scrolled into viewport
 *   'idle'    — hydrate when browser is idle
 *   'media'   — hydrate when media query matches (e.g. '(max-width:768px)')
 *   'none'    — never hydrate (static island, server HTML only)
 */

import {
  type VNode,
  type Props,
  type ComponentFn,
  escapeHtml,
} from './jsx-runtime';
import { renderToString } from './renderer';

export type HydrateStrategy = 'load' | 'visible' | 'idle' | 'none' | `media:${string}`;

export interface IslandConfig {
  /** Hydration strategy */
  hydrate?: HydrateStrategy;
  /** Fallback HTML while island JS loads (before hydration) */
  fallback?: VNode | string;
  /** Group name for chunk bundling (islands in same group = one JS file) */
  group?: string;
  /** Preload the island JS in <head> for above-fold islands */
  preload?: boolean;
}

export interface IslandDefinition {
  name: string;
  config: IslandConfig;
  component: ComponentFn;
}

/* Registry of all defined islands (for build-time chunk generation) */
const islandRegistry = new Map<string, IslandDefinition>();

export function getIslandRegistry(): Map<string, IslandDefinition> {
  return islandRegistry;
}

/**
 * Define an island component.
 * Returns a server-renderable VNode that includes hydration metadata.
 */
export function island(
  name: string,
  component: ComponentFn,
  config: IslandConfig = {}
): ComponentFn {
  const { hydrate = 'load', group, preload = false } = config;

  // Register for build-time processing
  islandRegistry.set(name, { name, config, component });

  // Return a wrapper component that renders server HTML + hydration markers
  const IslandWrapper: ComponentFn = async (props: Props) => {
    // Render server HTML
    const { children, ...serializableProps } = props;
    const componentProps: Props = { ...props };

    let serverHtml: string;
    try {
      const vnode = await component(componentProps);
      serverHtml = await renderToString(vnode);
    } catch (err) {
      // If server render fails, use fallback
      if (config.fallback) {
        if (typeof config.fallback === 'string') {
          serverHtml = escapeHtml(config.fallback);
        } else {
          serverHtml = await renderToString(config.fallback);
        }
      } else {
        serverHtml = `<!-- island:${name} render error -->`;
      }
    }

    // Serialize props for client hydration
    const propsJson = escapeHtml(JSON.stringify(serializableProps));

    // Build hydration attributes
    const attrs = [
      `data-island="${escapeHtml(name)}"`,
      `data-hydrate="${hydrate}"`,
    ];
    if (group) attrs.push(`data-island-group="${escapeHtml(group)}"`);
    if (preload) attrs.push('data-island-preload');

    // Return raw HTML VNode
    return {
      type: 'div',
      props: {
        dangerouslySetInnerHTML: {
          __html: `${serverHtml}<script type="application/json" data-island-props>${propsJson}</script>`,
        },
        'data-island': name,
        'data-hydrate': hydrate,
        ...(group ? { 'data-island-group': group } : {}),
        ...(preload ? { 'data-island-preload': true } : {}),
      },
      children: [],
    };
  };

  // Preserve name for debugging
  Object.defineProperty(IslandWrapper, 'name', { value: `Island(${name})` });

  return IslandWrapper;
}

/**
 * Generate island preload hints for <head>.
 * Call this to get <link rel="modulepreload"> tags for above-fold islands.
 */
export function getIslandPreloads(basePath = '/islands'): string {
  const preloads: string[] = [];
  for (const [name, def] of islandRegistry) {
    if (def.config.preload) {
      preloads.push(`<link rel="modulepreload" href="${basePath}/${name}.js" />`);
    }
  }
  return preloads.join('\n');
}

/**
 * Generate the island manifest for the build system.
 * Maps island names to their groups for chunk optimization.
 */
export function getIslandManifest(): Record<string, { group?: string; hydrate: HydrateStrategy }> {
  const manifest: Record<string, { group?: string; hydrate: HydrateStrategy }> = {};
  for (const [name, def] of islandRegistry) {
    manifest[name] = {
      group: def.config.group,
      hydrate: (def.config.hydrate || 'load') as HydrateStrategy,
    };
  }
  return manifest;
}
