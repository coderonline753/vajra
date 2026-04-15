/**
 * Vajra Feature Flags
 * Simple, typed, supports percentage rollouts and user targeting.
 *
 * @example
 *   const flags = createFeatureFlags({
 *     'new-checkout': { enabled: true },
 *     'dark-mode': { enabled: true, percentage: 50 },
 *     'beta-api': { enabled: true, allowList: ['user-1', 'user-2'] },
 *   });
 *
 *   if (flags.isEnabled('new-checkout')) { ... }
 *   if (flags.isEnabled('dark-mode', { userId: 'user-42' })) { ... }
 */

interface FlagConfig {
  /** Is the flag active? */
  enabled: boolean;
  /** Percentage rollout (0-100). Uses consistent hashing on userId. */
  percentage?: number;
  /** Only these user IDs get the feature. */
  allowList?: string[];
  /** These user IDs never get the feature. */
  denyList?: string[];
  /** Description for documentation. */
  description?: string;
}

interface FlagContext {
  userId?: string;
  [key: string]: unknown;
}

interface FeatureFlags {
  /** Check if a flag is enabled for a given context. */
  isEnabled(flag: string, context?: FlagContext): boolean;
  /** Get all flag statuses. */
  getAll(): Record<string, FlagConfig>;
  /** Update a flag at runtime. */
  set(flag: string, config: Partial<FlagConfig>): void;
  /** Add middleware that injects flags into context. */
  middleware(): import('./middleware').Middleware;
}

/**
 * Simple hash for consistent percentage rollout.
 * Same userId always gets same result for same flag.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Create a feature flag system.
 */
export function createFeatureFlags(
  initial: Record<string, FlagConfig>
): FeatureFlags {
  const flags = new Map<string, FlagConfig>(Object.entries(initial));

  function isEnabled(flag: string, context?: FlagContext): boolean {
    const config = flags.get(flag);
    if (!config) return false;
    if (!config.enabled) return false;

    const userId = context?.userId;

    // Deny list
    if (userId && config.denyList?.includes(userId)) return false;

    // Allow list (if set, only these users get it)
    if (config.allowList && config.allowList.length > 0) {
      return userId ? config.allowList.includes(userId) : false;
    }

    // Percentage rollout
    if (config.percentage !== undefined && config.percentage < 100) {
      if (!userId) return false; // No userId = no percentage rollout
      const hash = simpleHash(`${flag}:${userId}`);
      return (hash % 100) < config.percentage;
    }

    return true;
  }

  return {
    isEnabled,

    getAll() {
      return Object.fromEntries(flags);
    },

    set(flag: string, config: Partial<FlagConfig>) {
      const existing = flags.get(flag) || { enabled: false };
      flags.set(flag, { ...existing, ...config });
    },

    middleware() {
      return async (c, next) => {
        c.set('flags', { isEnabled: (f: string) => isEnabled(f, { userId: c.get('userId') as string }) });
        return next();
      };
    },
  };
}

export type { FlagConfig, FlagContext, FeatureFlags };
