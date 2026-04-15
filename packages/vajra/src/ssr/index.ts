/**
 * Vajra SSR — Server-Side Rendering Module
 * Islands Architecture + Loader Pattern + Streaming SSR
 *
 * "Server by default. Islands for interactivity. No magic."
 */

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
