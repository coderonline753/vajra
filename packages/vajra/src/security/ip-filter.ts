/**
 * Vajra IP Filter
 * Whitelist/blacklist with CIDR support. IPv4 only for v1.
 */

import type { Context } from '../context';
import type { Middleware } from '../middleware';
import { getClientIp } from './utils';

interface CidrEntry {
  base: number;
  mask: number;
}

interface IpFilterOptions {
  mode: 'whitelist' | 'blacklist';
  ips: string[];
  trustProxy?: boolean;
  proxyHeaders?: string[];
  message?: string;
  onDenied?: (c: Context, ip: string) => Response | Promise<Response>;
}

/** Parse IPv4 string to 32-bit integer */
export function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // unsigned
}

/** Parse CIDR notation to base + mask */
function parseCidr(cidr: string): CidrEntry | null {
  const [ip, bits] = cidr.split('/');
  if (!bits) return null;

  const base = parseIpv4(ip);
  if (base === null) return null;

  const maskBits = parseInt(bits, 10);
  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return null;

  const mask = maskBits === 0 ? 0 : maskBits === 32 ? 0xFFFFFFFF : (~0 << (32 - maskBits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/** Check if an IP is within a CIDR range */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const ipNum = parseIpv4(ip);
  if (ipNum === null) return false;

  const entry = parseCidr(cidr);
  if (!entry) return false;

  return ((ipNum & entry.mask) >>> 0) === entry.base;
}

export function ipFilter(options: IpFilterOptions): Middleware {
  const { mode, message = 'Forbidden', onDenied } = options;
  const trustProxy = options.trustProxy ?? true;
  const proxyHeaders = options.proxyHeaders;

  // Pre-process: exact IPs in Set, CIDRs in array
  const exactIps = new Set<string>();
  const cidrs: CidrEntry[] = [];

  for (const entry of options.ips) {
    if (entry.includes('/')) {
      const parsed = parseCidr(entry);
      if (parsed) cidrs.push(parsed);
    } else {
      exactIps.add(entry);
    }
  }

  function isMatch(ip: string): boolean {
    // O(1) exact match
    if (exactIps.has(ip)) return true;

    // CIDR scan
    const ipNum = parseIpv4(ip);
    if (ipNum === null) return false;

    for (const cidr of cidrs) {
      if (((ipNum & cidr.mask) >>> 0) === cidr.base) return true;
    }

    return false;
  }

  return async (c, next) => {
    const ip = getClientIp(c, { trustProxy, proxyHeaders });
    const matched = isMatch(ip);

    const denied = mode === 'whitelist' ? !matched : matched;

    if (denied) {
      if (onDenied) return onDenied(c, ip);
      return c.json({ error: message }, 403);
    }

    return next();
  };
}
