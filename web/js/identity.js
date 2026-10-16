// Device identity: a long-term ECDSA P-256 keypair kept in IndexedDB. The
// private key is non-extractable. The device ID is base64url(SHA-256(raw public key)).
// Trusted (paired) peers are pinned here too, keyed by device ID.

const DB = 'softdrop';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp = null;
function db() {
  return (dbp ||= openDb());
}

export async function kvGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function kvSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const b64url = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const enc = new TextEncoder();
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

export async function idForPub(pubB64) {
  return b64url.enc(await crypto.subtle.digest('SHA-256', b64url.dec(pubB64)));
}

const keyCache = new Map();
async function importPub(pubB64) {
  if (!keyCache.has(pubB64)) keyCache.set(pubB64, crypto.subtle.importKey('raw', b64url.dec(pubB64), ALG, false, ['verify']));
  return keyCache.get(pubB64);
}

export async function verify(pubB64, sigB64, text) {
  try {
    return await crypto.subtle.verify(SIG, await importPub(pubB64), b64url.dec(sigB64), enc.encode(text));
  } catch {
    return false;
  }
}

const ADJ = ['Quiet', 'Gentle', 'Soft', 'Calm', 'Mellow', 'Warm', 'Sleepy', 'Misty', 'Tender', 'Hazy', 'Velvet', 'Amber', 'Rosy', 'Silver', 'Little', 'Sunny'];
const NOUN = ['Fox', 'Otter', 'Fern', 'Pebble', 'Cloud', 'Moth', 'Wren', 'Cedar', 'Mochi', 'Linen', 'Plum', 'Heron', 'Willow', 'Badger', 'Lark', 'Maple'];
function friendlyName() {
  const r = crypto.getRandomValues(new Uint8Array(2));
  return ADJ[r[0] % ADJ.length] + ' ' + NOUN[r[1] % NOUN.length];
}

/** A short label like "iPhone" or "MacBook", plus an icon name for the radar. */
export function deviceKind() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || touchMac) return { kind: 'iPad', icon: 'tablet' };
  if (/iPhone|iPod/.test(ua)) return { kind: 'iPhone', icon: 'phone' };
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'Android', icon: 'phone' } : { kind: 'Android tablet', icon: 'tablet' };
  if (/CrOS/.test(ua)) return { kind: 'Chromebook', icon: 'laptop' };
  if (/Macintosh|Mac OS X/.test(ua)) return { kind: 'Mac', icon: 'laptop' };
  if (/Windows/.test(ua)) return { kind: 'Windows PC', icon: 'desktop' };
  if (/Linux/.test(ua)) return { kind: 'Linux', icon: 'desktop' };
  return { kind: 'Browser', icon: 'desktop' };
}

export function iconForKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (/iphone|android$|phone|pixel/.test(k)) return 'phone';
  if (/ipad|tablet/.test(k)) return 'tablet';
  if (/mac|book|laptop/.test(k)) return 'laptop';
  return 'desktop';
}

export class Identity {
  static async load() {
    let rec = await kvGet('identity');
    if (!rec) {
      const kp = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
      const pub = b64url.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
      rec = { privateKey: kp.privateKey, pub, name: friendlyName(), created: Date.now() };
      await kvSet('identity', rec);
    }
    const me = new Identity();
    me.privateKey = rec.privateKey;
    me.pub = rec.pub;
    me.id = await idForPub(rec.pub);
    me.name = rec.name;
    Object.assign(me, deviceKind());
    me.trusted = (await kvGet('trusted')) || {};
    return me;
  }

  async sign(text) {
    return b64url.enc(await crypto.subtle.sign(SIG, this.privateKey, enc.encode(text)));
  }

  async rename(name) {
    this.name = name;
    const rec = await kvGet('identity');
    rec.name = name;
    await kvSet('identity', rec);
  }

  isTrusted(id) {
    return Object.prototype.hasOwnProperty.call(this.trusted, id);
  }

  async trust(peer) {
    this.trusted[peer.id] = { id: peer.id, pub: peer.pub, name: peer.name, kind: peer.kind, since: Date.now() };
    await kvSet('trusted', this.trusted);
  }

  async forget(id) {
    delete this.trusted[id];
    await kvSet('trusted', this.trusted);
  }
}

/** Short authentication string both users compare after pairing: 6 digits. */
export async function sasFor(pubA, pubB) {
  const [x, y] = [pubA, pubB].sort();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('softdrop/sas\n' + x + '\n' + y)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}
