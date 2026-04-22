/**
 * Vajra Helmet — Enhanced Security Headers
 * Configurable per-header, strings built at construction time.
 */

import type { Middleware } from '../middleware';

interface CspOptions {
  directives: Record<string, string[]>;
  reportOnly?: boolean;
}

interface HstsOptions {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

/**
 * Built-in helmet presets.
 *
 * - `'api'` (default): strict `default-src 'self'`. Correct for backend APIs
 *   that serve only same-origin JSON / no external assets.
 * - `'web-app'`: relaxed CSP for content sites. Permits HTTPS images, Google
 *   Fonts, and inline styles. Script execution stays restricted to same-origin.
 *
 * Pick a preset that matches what your app actually serves. New users
 * building content sites with bare `helmet()` previously hit the strict
 * default and saw broken images / fonts; `'web-app'` solves that without
 * weakening XSS protection.
 */
export type HelmetPreset = 'api' | 'web-app';

export interface HelmetOptions {
  /**
   * Pick a baseline. Defaults to `'api'`. Any explicit option below overrides
   * the preset's value for that field. CSP directives replace, not merge —
   * if you supply `contentSecurityPolicy.directives` you own the full set.
   */
  preset?: HelmetPreset;
  contentSecurityPolicy?: CspOptions | false;
  strictTransportSecurity?: HstsOptions | false;
  xContentTypeOptions?: boolean;
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  xXssProtection?: boolean;
  referrerPolicy?: string | false;
  permissionsPolicy?: Record<string, string[]> | false;
  crossOriginEmbedderPolicy?: 'require-corp' | 'unsafe-none' | 'credentialless' | false;
  crossOriginOpenerPolicy?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false;
  crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false;
  xPermittedCrossDomainPolicies?: 'none' | 'master-only' | 'by-content-type' | 'all' | false;
  xDnsPrefetchControl?: boolean;
}

const PRESET_CSP: Record<HelmetPreset, CspOptions> = {
  api: {
    directives: {
      'default-src': ["'self'"],
    },
  },
  'web-app': {
    directives: {
      'default-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'script-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'self'"],
    },
  },
};

function buildCsp(options: CspOptions): string {
  return Object.entries(options.directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

function buildHsts(options: HstsOptions): string {
  const maxAge = options.maxAge ?? 31536000;
  let value = `max-age=${maxAge}`;
  if (options.includeSubDomains ?? true) value += '; includeSubDomains';
  if (options.preload) value += '; preload';
  return value;
}

function buildPermissionsPolicy(policy: Record<string, string[]>): string {
  return Object.entries(policy)
    .map(([feature, allowlist]) => {
      if (allowlist.length === 0) return `${feature}=()`;
      return `${feature}=(${allowlist.join(' ')})`;
    })
    .join(', ');
}

export function helmet(options: HelmetOptions = {}): Middleware {
  // Pre-build all header values at construction time
  const headers: [string, string][] = [];
  const preset = options.preset ?? 'api';

  // Content-Security-Policy
  const csp = options.contentSecurityPolicy;
  if (csp !== false) {
    const effectiveCsp: CspOptions = csp ?? PRESET_CSP[preset];
    const cspValue = buildCsp(effectiveCsp);
    const headerName = effectiveCsp.reportOnly
      ? 'content-security-policy-report-only'
      : 'content-security-policy';
    headers.push([headerName, cspValue]);
  }

  // Strict-Transport-Security
  const hsts = options.strictTransportSecurity;
  if (hsts !== false) {
    headers.push(['strict-transport-security', buildHsts(typeof hsts === 'object' ? hsts : {})]);
  }

  // X-Content-Type-Options
  if (options.xContentTypeOptions !== false) {
    headers.push(['x-content-type-options', 'nosniff']);
  }

  // X-Frame-Options
  const xfo = options.xFrameOptions;
  if (xfo !== false) {
    headers.push(['x-frame-options', xfo ?? 'DENY']);
  }

  // X-XSS-Protection
  if (options.xXssProtection !== false) {
    headers.push(['x-xss-protection', '0']);
  }

  // Referrer-Policy
  const rp = options.referrerPolicy;
  if (rp !== false) {
    headers.push(['referrer-policy', rp ?? 'strict-origin-when-cross-origin']);
  }

  // Permissions-Policy
  const pp = options.permissionsPolicy;
  if (pp !== false) {
    const defaultPolicy = { camera: [], microphone: [], geolocation: [] };
    headers.push(['permissions-policy', buildPermissionsPolicy(pp ?? defaultPolicy)]);
  }

  // Cross-Origin-Embedder-Policy
  if (options.crossOriginEmbedderPolicy !== false && options.crossOriginEmbedderPolicy) {
    headers.push(['cross-origin-embedder-policy', options.crossOriginEmbedderPolicy]);
  }

  // Cross-Origin-Opener-Policy
  if (options.crossOriginOpenerPolicy !== false && options.crossOriginOpenerPolicy) {
    headers.push(['cross-origin-opener-policy', options.crossOriginOpenerPolicy]);
  }

  // Cross-Origin-Resource-Policy
  if (options.crossOriginResourcePolicy !== false && options.crossOriginResourcePolicy) {
    headers.push(['cross-origin-resource-policy', options.crossOriginResourcePolicy]);
  }

  // X-Permitted-Cross-Domain-Policies
  const xpcdp = options.xPermittedCrossDomainPolicies;
  if (xpcdp !== false && xpcdp) {
    headers.push(['x-permitted-cross-domain-policies', xpcdp]);
  }

  // X-DNS-Prefetch-Control
  if (options.xDnsPrefetchControl === true) {
    headers.push(['x-dns-prefetch-control', 'on']);
  } else if (options.xDnsPrefetchControl === false) {
    headers.push(['x-dns-prefetch-control', 'off']);
  }

  return async (_c, next) => {
    const res = await next();
    for (const [name, value] of headers) {
      if (!res.headers.has(name)) {
        res.headers.set(name, value);
      }
    }
    return res;
  };
}
