/**
 * Vajra SSRF Prevention
 * Blocks requests to internal/private networks.
 * Use when your app fetches user-provided URLs (webhooks, image proxy, etc.)
 */

/**
 * Check if a URL points to an internal/private network.
 * Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16 (link-local), 0.0.0.0, ::1, cloud metadata IPs.
 */
export function isInternalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block common internal hostnames
    if (
      hostname === 'localhost' ||
      hostname === 'host.docker.internal' ||
      hostname === 'kubernetes.default' ||
      hostname === 'metadata.google.internal' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return true;
    }

    // Check IP-based hostnames
    if (isPrivateIP(hostname)) return true;

    // Block cloud metadata endpoints
    if (
      hostname === '169.254.169.254' || // AWS/GCP metadata
      hostname === '100.100.100.200' || // Alibaba metadata
      hostname === '169.254.170.2'      // AWS ECS metadata
    ) {
      return true;
    }

    return false;
  } catch {
    // Invalid URL = block it
    return true;
  }
}

/**
 * Check if an IP address is in a private/reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1' || ip === '[::1]') return true;

  // IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // Strip brackets for IPv6
  ip = ip.replace(/^\[|\]$/g, '');

  // IPv4 check
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;

    if (a === 0) return true;                    // 0.0.0.0/8
    if (a === 10) return true;                   // 10.0.0.0/8
    if (a === 127) return true;                  // 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;     // 192.168.0.0/16
    if (a === 169 && b === 254) return true;     // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGN
    if (a >= 224) return true;                   // 224.0.0.0+ multicast/reserved
  }

  // IPv6 private ranges
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA
  if (ip.startsWith('fe80')) return true; // Link-local

  return false;
}

/**
 * Middleware: validate URL parameter before fetching.
 * Use on endpoints that proxy user-provided URLs.
 *
 * @example
 *   app.post('/api/webhooks/test', ssrfGuard('url'), handler)
 */
import type { Middleware } from '../middleware';

export function ssrfGuard(fieldName = 'url'): Middleware {
  return async (c, next) => {
    const body = await c.body<Record<string, unknown>>();
    const url = body?.[fieldName];

    if (typeof url === 'string' && isInternalUrl(url)) {
      return c.json({
        error: 'Forbidden',
        message: 'URL points to an internal network and is not allowed',
        code: 'SSRF_BLOCKED',
      }, 403);
    }

    return next();
  };
}
