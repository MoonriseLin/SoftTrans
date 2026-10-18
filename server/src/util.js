import { webcrypto, createHmac, randomBytes, randomInt } from 'node:crypto';
import net from 'node:net';

const subtle = webcrypto.subtle;

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s, 'base64url');
}

/** Device ID = base64url(SHA-256(raw P-256 public key)). */
export async function deviceIdFor(pubRaw) {
  return b64url(await subtle.digest('SHA-256', pubRaw));
}

/** Verify an ECDSA P-256 / SHA-256 signature (IEEE P1363, as WebCrypto produces). */
export async function verifySig(pubRaw, sigRaw, text) {
  try {
    const key = await subtle.importKey('raw', pubRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

export function nonce() {
  return randomBytes(18).toString('base64url');
}

export function pairCode() {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/**
 * Group key for "nearby": the public IPv4 address, or the /64 prefix for IPv6.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are treated as IPv4.
 */
export function groupKey(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return '4:' + ip;
  if (!net.isIPv6(ip)) return 'unknown';
  return '6:' + expandV6(ip).slice(0, 4).join(':');
}

function expandV6(ip) {
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((p) => p.toLowerCase().padStart(4, '0'));
}

/** TURN REST credentials shared with coturn's use-auth-secret. */
export function turnCredentials(secret, deviceId, ttlSeconds) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${deviceId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiry };
}

/** Sliding-window counter keyed by string, for per-IP limits. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  /** Returns true if the action is allowed (and records it). */
  take(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) {
      const keep = list.filter((t) => now - t < this.windowMs);
      if (keep.length) this.hits.set(k, keep);
      else this.hits.delete(k);
    }
  }
}
