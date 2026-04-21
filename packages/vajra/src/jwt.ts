/**
 * Vajra JWT Authentication
 * HMAC-SHA256 using Web Crypto API. Zero external dependencies.
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import { HttpError } from './context';

interface JwtPayload {
  [key: string]: unknown;
  iat?: number;
  exp?: number;
}

interface JwtOptions {
  secret: string;
  algorithms?: string[];
  extractToken?: (c: Context) => string | null;
}

const encoder = new TextEncoder();

function base64UrlEncode(data: Uint8Array): string {
  const str = btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

async function getCryptoKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function jwtSign(payload: JwtPayload, secret: string, expiresIn?: number): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: payload.iat ?? now,
  };
  if (expiresIn) {
    fullPayload.exp = now + expiresIn;
  }

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getCryptoKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function jwtVerify(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Invalid token format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify header
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    if (header.alg !== 'HS256') {
      throw new HttpError(401, 'Unsupported algorithm');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, 'Invalid token header');
  }

  // Verify signature
  const key = await getCryptoKey(secret);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));

  if (!valid) {
    throw new HttpError(401, 'Invalid token signature');
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new HttpError(401, 'Invalid token payload');
  }

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, 'Token expired');
  }

  return payload;
}

function defaultExtractToken(c: Context): string | null {
  const auth = c.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

export function jwt(options: JwtOptions): Middleware {
  const extractToken = options.extractToken ?? defaultExtractToken;

  return async (c, next) => {
    const token = extractToken(c);
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const payload = await jwtVerify(token, options.secret);
      c.set('jwtPayload', payload);
    } catch (err) {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return next();
  };
}
