/**
 * Vajra Island Hydrator — Client Side (~2KB minified)
 * Auto-discovers islands in DOM, hydrates based on strategy.
 * Include this script on pages that have islands.
 *
 * Usage in HTML:
 *   <script type="module" src="/vajra-islands.js"></script>
 */

type HydrateFn = () => Promise<void>;

interface IslandModule {
  default: {
    mount: (el: HTMLElement, props: Record<string, unknown>) => void;
  };
}

/* Hydration strategy handlers */
const strategies: Record<string, (el: HTMLElement, hydrate: HydrateFn) => void> = {
  load(_, hydrate) {
    hydrate();
  },

  visible(el, hydrate) {
    if (typeof IntersectionObserver === 'undefined') {
      hydrate();
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          hydrate();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
  },

  idle(_, hydrate) {
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(hydrate);
    } else {
      setTimeout(hydrate, 200);
    }
  },

  none() {
    // Never hydrate
  },
};

/* Media query strategy */
function mediaStrategy(query: string, _el: HTMLElement, hydrate: HydrateFn) {
  const mql = window.matchMedia(query);
  if (mql.matches) {
    hydrate();
  } else {
    mql.addEventListener('change', () => hydrate(), { once: true });
  }
}

/* Auto-discover and hydrate all islands */
export function hydrateIslands(basePath = '/islands'): void {
  const islands = document.querySelectorAll<HTMLElement>('[data-island]');

  for (const el of islands) {
    const name = el.dataset.island;
    const strategy = el.dataset.hydrate || 'load';
    if (!name) continue;

    // Find serialized props
    const propsScript = el.querySelector<HTMLScriptElement>('script[data-island-props]');
    let props: Record<string, unknown> = {};
    if (propsScript) {
      try {
        props = JSON.parse(propsScript.textContent || '{}');
      } catch {
        console.warn(`[Vajra] Failed to parse props for island: ${name}`);
      }
    }

    // Build hydrate function
    const hydrate: HydrateFn = async () => {
      try {
        const group = el.dataset.islandGroup;
        const modulePath = group
          ? `${basePath}/${group}.js`
          : `${basePath}/${name}.js`;

        const mod = await import(/* @vite-ignore */ modulePath) as IslandModule;

        if (mod.default?.mount) {
          // Remove the props script before mounting
          propsScript?.remove();
          mod.default.mount(el, props);
        } else {
          console.warn(`[Vajra] Island "${name}" has no default.mount export`);
        }
      } catch (err) {
        console.error(`[Vajra] Failed to hydrate island "${name}":`, err);
      }
    };

    // Apply strategy
    if (strategy.startsWith('media:')) {
      const query = strategy.slice(6);
      mediaStrategy(query, el, hydrate);
    } else if (strategies[strategy]) {
      strategies[strategy](el, hydrate);
    } else {
      strategies.load(el, hydrate);
    }
  }
}

/* Auto-run on DOM ready */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrateIslands());
  } else {
    hydrateIslands();
  }
}
