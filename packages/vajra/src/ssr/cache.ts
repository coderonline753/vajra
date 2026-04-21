/**
 * Vajra SSR Cache
 * Single layer, explicit, OFF by default.
 * In-memory LRU cache for rendered HTML pages.
 */

interface CacheEntry {
  html: string;
  headers: Record<string, string>;
  createdAt: number;
  maxAge: number;
  tags: string[];
  staleWhileRevalidate: number;
}

export interface SSRCacheOptions {
  /** Maximum cached pages (default: 1000) */
  maxSize?: number;
  /** Default max age in seconds (default: 60) */
  defaultMaxAge?: number;
}

export class SSRCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private defaultMaxAge: number;

  constructor(options: SSRCacheOptions = {}) {
    this.maxSize = options.maxSize || 1000;
    this.defaultMaxAge = options.defaultMaxAge || 60;
  }

  /** Get cached response. Returns null if miss or expired. */
  get(key: string): { html: string; headers: Record<string, string>; stale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = (Date.now() - entry.createdAt) / 1000;

    // Fresh
    if (age <= entry.maxAge) {
      return { html: entry.html, headers: entry.headers, stale: false };
    }

    // Stale but within SWR window
    if (age <= entry.maxAge + entry.staleWhileRevalidate) {
      return { html: entry.html, headers: entry.headers, stale: true };
    }

    // Expired
    this.cache.delete(key);
    return null;
  }

  /** Store rendered page in cache */
  set(
    key: string,
    html: string,
    options: {
      headers?: Record<string, string>;
      maxAge?: number;
      tags?: string[];
      staleWhileRevalidate?: number;
    } = {}
  ): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      html,
      headers: options.headers || {},
      createdAt: Date.now(),
      maxAge: options.maxAge || this.defaultMaxAge,
      tags: options.tags || [],
      staleWhileRevalidate: options.staleWhileRevalidate || 0,
    });
  }

  /** Invalidate by exact path */
  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Invalidate by tags */
  invalidateByTags(tags: string[]): number {
    const tagSet = new Set(tags);
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.tags.some(t => tagSet.has(t))) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Clear all cached pages */
  purgeAll(): void {
    this.cache.clear();
  }

  /** Get cache stats */
  stats(): { size: number; maxSize: number; keys: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      keys: [...this.cache.keys()],
    };
  }

  /** Generate cache key from request */
  static key(url: URL, varyBy?: string[]): string {
    let key = url.pathname;
    if (url.search) key += url.search;
    // varyBy would need request headers, handled at middleware level
    return key;
  }
}
