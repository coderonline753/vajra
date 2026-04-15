/**
 * Vajra HMAC Verification
 * Verify webhook signatures (GitHub, Stripe, etc.). Zero dependencies.
 */

import type { Context } from '../context';
import type { Middleware } from '../middleware';
import { timingSafeEqual } from './utils';

interface HmacVerifyOptions {
  secret: string | ((c: Context) => string | Promise<string>);
  header?: string;
  algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512';
  prefix?: string;
  encoding?: 'hex' | 'base64';
  errorMessage?: string;
}

const encoder = new TextEncoder();

async function getCryptoKey(secret: string, algorithm: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/** Compute HMAC signature for a payload */
export async function computeHmac(
  payload: string,
  secret: string,
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256',
  encoding: 'hex' | 'base64' = 'hex'
): Promise<string> {
  const key = await getCryptoKey(secret, algorithm);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return encoding === 'hex' ? toHex(signature) : toBase64(signature);
}

/** Verify an HMAC signature */
export async function verifyHmac(
  payload: string,
  secret: string,
  signature: string,
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256',
  encoding: 'hex' | 'base64' = 'hex'
): Promise<boolean> {
  const expected = await computeHmac(payload, secret, algorithm, encoding);
  return timingSafeEqual(expected, signature);
}

/** Middleware to verify HMAC signatures on incoming requests */
export function hmacVerify(options: HmacVerifyOptions): Middleware {
  const headerName = options.header ?? 'x-signature-256';
  const algorithm = options.algorithm ?? 'SHA-256';
  const prefix = options.prefix ?? 'sha256=';
  const encoding = options.encoding ?? 'hex';
  const errorMessage = options.errorMessage ?? 'Invalid signature';

  return async (c, next) => {
    const signatureHeader = c.header(headerName);
    if (!signatureHeader) {
      return c.json({ error: errorMessage }, 403);
    }

    // Strip prefix
    let signature = signatureHeader;
    if (prefix && signature.startsWith(prefix)) {
      signature = signature.slice(prefix.length);
    }

    // Get secret (static or dynamic)
    const secret = typeof options.secret === 'function'
      ? await options.secret(c)
      : options.secret;

    // Read raw body without consuming the original
    const rawBody = await c.req.clone().text();
    c.set('rawBody', rawBody);

    // Verify
    const valid = await verifyHmac(rawBody, secret, signature, algorithm, encoding);
    if (!valid) {
      return c.json({ error: errorMessage }, 403);
    }

    return next();
  };
}
