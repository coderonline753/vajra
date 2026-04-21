/**
 * Vajra SSR — Server-Side Rendering Module (EXPERIMENTAL)
 * Islands Architecture + Loader Pattern + Streaming SSR
 *
 * "Server by default. Islands for interactivity. No magic."
 *
 * STATUS: Experimental in v1.0. Code is complete and tested (83+ tests) but lacks
 * production dogfood at scale. API may receive breaking changes before v2.0.
 * Use in production with awareness of this caveat.
 * For stable API, use Vajra as a backend + pair with Vue 3 / React 19 SPA.
 */

/** @experimental — SSR module is opt-in and may evolve before v2.0 */
export const SSR_EXPERIMENTAL = true as const;

/* JSX Runtime */
export {
  jsx,
  jsxs,
  jsxDEV,
  createElement,
  Fragment,
  Suspense,
  escapeHtml,
  isVNode,
  type VNode,
  type Child,
  type Props,
  type ComponentFn,
  type SuspenseProps,
} from './jsx-runtime';

/* Renderer */
export {
  renderToString,
  renderToStream,
} from './renderer';

/* Islands */
export {
  island,
  getIslandRegistry,
  getIslandPreloads,
  getIslandManifest,
  type IslandConfig,
  type IslandDefinition,
  type HydrateStrategy,
} from './island';

/* Route (Loader Pattern) */
export {
  defineRoute,
  type RouteDefinition,
  type RouteContext,
  type RouteCacheConfig,
} from './route';

/* Head Manager */
export {
  renderHead,
  type HeadData,
} from './head';

/* Reactive Store (Inter-island state) */
export {
  atom,
  computed,
  computedFrom,
  map,
  action,
  batch,
  serializeStores,
  hydrateStores,
  type Atom,
  type Computed,
  type MapStore,
} from './store';

/* SSR Cache */
export {
  SSRCache,
  type SSRCacheOptions,
} from './cache';
