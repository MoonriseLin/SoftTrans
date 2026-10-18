// The hub routes messages between devices. It never sees transfer data: that
// travels over WebRTC data channels, end-to-end encrypted. The hub only knows
// who is online, which group (public IP) they share, and which devices have
// told it they are paired with each other.

import { deviceIdFor, fromB64url, verifySig, nonce, pairCode, turnCredentials, RateLimiter } from './util.js';

const NAME_MAX = 40;
const KIND_MAX = 24;
const LINKS_MAX = 64;
const SIGNAL_DATA_MAX = 32 * 1024;
const PAIR_TTL_S = 300;
const HELLO_TIMEOUT_MS = 10_000;

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export class Hub {
  /**
   * @param {object} opts
   * @param {string} [opts.turnSecret]  shared with coturn (use-auth-secret)
   * @param {string[]} [opts.stunUrls]
   * @param {string[]} [opts.turnUrls]
   * @param {number} [opts.turnTtl]     seconds
   * @param {(level: string, event: string, fields?: object) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.opts = { turnTtl: 6 * 3600, stunUrls: [], turnUrls: [], log: () => {}, ...opts };
    /** @type {Map<string, Client>} device id -> client */
    this.clients = new Map();
    /** @type {Map<string, Set<Client>>} group key -> clients */
    this.groups = new Map();
    /** @type {Map<string, {id: string, expires: number}>} */
    this.codes = new Map();
    this.pairCreateLimit = new RateLimiter(10, 10 * 60_000);
    this.pairJoinLimit = new RateLimiter(12, 10 * 60_000);
    this.helloLimit = new RateLimiter(60, 60_000);
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
    this.nextConn = 1;
  }

  log(level, event, fields) {
    this.opts.log(level, event, fields);
  }

  close() {
    clearInterval(this.sweeper);
  }

  /**
   * A new transport connection. `conn` needs send(string) and close(code, reason).
   * Returns handlers the transport calls on message and close.
   */
  connect(conn, ip, group) {
    const c = new Client(conn, ip, group, this, this.nextConn++);
    this.log('info', 'ws.open', { conn: c.cid, ip, group });
    c.nonce = nonce();
    c.send({ t: 'challenge', nonce: c.nonce });
    c.helloTimer = setTimeout(() => {
      if (!c.id) {
        this.log('warn', 'hello.timeout', c.tag());
        conn.close(4000, 'no hello');
      }
    }, HELLO_TIMEOUT_MS);
    c.helloTimer.unref?.();
    return {
      message: (raw) => this.onMessage(c, raw).catch((e) => this.log('error', 'handler.error', { ...c.tag(), err: e.message })),
      close: (code, reason) => {
        if (!c.closed) this.log('info', 'ws.close', { ...c.tag(), code, reason, secs: Math.round((Date.now() - c.t0) / 1000) });
        this.onClose(c);
      },
    };
  }

  async onMessage(c, raw) {
    if (!c.allowMessage()) {
      c.error('rate-limited', 'Slow down a little.');
      return;
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return c.error('bad-message', 'Not JSON.');
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return c.error('bad-message', 'Missing type.');

    if (m.t === 'ping') {
      this.log('debug', 'ping', c.tag());
      return c.send({ t: 'pong' });
    }
    if (m.t === 'hello') return this.onHello(c, m);
    if (!c.id) return c.error('no-hello', 'Say hello first.');

    switch (m.t) {
      case 'signal': return this.onSignal(c, m);
      case 'links': return this.onLinks(c, m);
      case 'rename': return this.onRename(c, m);
      case 'ice':
        this.log('info', 'ice.refresh', c.tag());
        return c.send({ t: 'ice', ice: this.iceFor(c.id) });
      case 'pair-create': return this.onPairCreate(c);
      case 'pair-join': return this.onPairJoin(c, m);
      case 'pair-cancel':
        this.log('debug', 'pair.cancel', c.tag());
        return this.dropCodesOf(c.id);
      case 'log': return this.onClientLog(c, m);
      default: return c.error('bad-message', 'Unknown type.');
    }
  }

  async onHello(c, m) {
    if (c.id || c.helloBusy) return c.error('bad-message', 'Already registered.');
    if (!this.helloLimit.take(c.ip)) return c.error('rate-limited', 'Too many connections.');
    c.helloBusy = true;
    const pubRaw = fromB64url(m.pub);
    const sigRaw = fromB64url(m.sig);
    if (!pubRaw || pubRaw.length !== 65 || !sigRaw || typeof m.id !== 'string') {
      c.helloBusy = false;
      return c.error('bad-hello', 'Malformed hello.');
    }
    const id = await deviceIdFor(pubRaw);
    if (id !== m.id) {
      c.helloBusy = false;
      return c.error('bad-hello', 'Device ID does not match key.');
    }
    if (!(await verifySig(pubRaw, sigRaw, `softdrop/hello\n${c.nonce}\n${id}`))) {
      c.helloBusy = false;
      return c.error('bad-hello', 'Bad signature.');
    }
    if (c.closed) return;
    clearTimeout(c.helloTimer);

    // Same device from another tab or a stale socket: the newest one wins.
    const old = this.clients.get(id);
    if (old) {
      this.log('info', 'hello.replaced', { dev: id.slice(0, 8), oldConn: old.cid, newConn: c.cid });
      old.send({ t: 'error', code: 'replaced', msg: 'Opened somewhere else.' });
      old.conn.close(4001, 'replaced');
      this.onClose(old);
    }

    c.id = id;
    c.pub = m.pub;
    c.name = cleanText(m.name, NAME_MAX) || 'New device';
    c.kind = cleanText(m.kind, KIND_MAX) || 'Device';
    c.links = this.cleanLinks(m.links, id);
    this.clients.set(id, c);
    if (!this.groups.has(c.group)) this.groups.set(c.group, new Set());
    this.groups.get(c.group).add(c);

    c.visible = this.visibleFor(c);
    c.send({
      t: 'welcome',
      you: { id, name: c.name, kind: c.kind },
      peers: [...c.visible].map(([vid, via]) => this.peerInfo(this.clients.get(vid), via)),
      ice: this.iceFor(id),
    });
    this.refreshAround(c);
    this.log('info', 'hello.ok', {
      ...c.tag(), name: c.name, kind: c.kind, ip: c.ip, group: c.group, links: c.links.size,
      sees: [...c.visible].map(([vid, via]) => `${this.label(vid)}(${via})`).join(',') || 'nobody',
    });
  }

  onSignal(c, m) {
    const to = this.clients.get(m.to);
    if (!to || !c.visible.has(to.id)) return c.error('unknown-peer', 'That device is not here.', { to: m.to });
    if (!['offer', 'answer', 'ice', 'bye'].includes(m.kind)) return c.error('bad-message', 'Bad signal kind.');
    if (typeof m.data !== 'string' || m.data.length > SIGNAL_DATA_MAX) return c.error('bad-message', 'Bad signal data.');
    if (typeof m.sig !== 'string' || m.sig.length > 200 || !Number.isFinite(m.ts)) return c.error('bad-message', 'Unsigned signal.');
    this.log('info', 'signal', { from: this.label(c.id), to: this.label(to.id), kind: m.kind, bytes: m.data.length, ...describeSignal(m.kind, m.data) });
    // Forwarded verbatim. The receiver checks the signature against the sender's key.
    to.send({ t: 'signal', from: c.id, kind: m.kind, data: m.data, ts: m.ts, sig: m.sig });
  }

  onLinks(c, m) {
    const oldLinks = c.links;
    c.links = this.cleanLinks(m.ids, c.id);
    this.log('info', 'links', { ...c.tag(), trusts: [...c.links].map((x) => this.label(x)).join(',') || 'none' });
    this.refreshAround(c, oldLinks);
  }

  onRename(c, m) {
    const name = cleanText(m.name, NAME_MAX);
    if (!name) return;
    this.log('info', 'rename', { ...c.tag(), from: c.name, to: name });
    c.name = name;
    for (const vid of c.visible.keys()) {
      const v = this.clients.get(vid);
      if (v) v.send({ t: 'peer-updated', peer: this.peerInfo(c, v.visible.get(c.id)) });
    }
  }

  onPairCreate(c) {
    if (!this.pairCreateLimit.take(c.ip)) return c.error('rate-limited', 'Too many codes. Try again in a few minutes.');
    this.dropCodesOf(c.id);
    let code, tries = 0;
    do code = pairCode(); while (this.codes.has(code) && ++tries < 50);
    if (this.codes.has(code)) return c.error('rate-limited', 'Too many codes in use. Try again in a minute.');
    this.codes.set(code, { id: c.id, expires: Date.now() + PAIR_TTL_S * 1000 });
    c.send({ t: 'pair-code', code, ttl: PAIR_TTL_S });
    this.log('info', 'pair.code', { ...c.tag(), code: code.slice(0, 1) + '***', ttl: PAIR_TTL_S });
  }

  onPairJoin(c, m) {
    const code = typeof m.code === 'string' ? m.code.replace(/\D/g, '') : '';
    const entry = this.codes.get(code);
    if (entry && entry.id === c.id) return c.error('own-code', 'That is your own code.');
    if (!this.pairJoinLimit.take(c.ip)) return c.error('rate-limited', 'Too many tries. Wait a few minutes.');
    const owner = entry && entry.expires > Date.now() ? this.clients.get(entry.id) : null;
    if (!owner) {
      this.log('warn', 'pair.join.fail', { ...c.tag(), why: !entry ? 'unknown' : entry.expires <= Date.now() ? 'expired' : 'owner offline' });
      if (entry) this.codes.delete(code);
      return c.error('bad-code', 'That code did not work. Check it, or ask for a new one.');
    }
    this.codes.delete(code); // single use
    owner.send({ t: 'paired', peer: { id: c.id, name: c.name, kind: c.kind, pub: c.pub } });
    c.send({ t: 'paired', peer: { id: owner.id, name: owner.name, kind: owner.kind, pub: owner.pub } });
    this.log('info', 'pair.ok', { a: this.label(owner.id), b: this.label(c.id), sameGroup: owner.group === c.group });
  }

  onClose(c) {
    if (c.closed) return;
    c.closed = true;
    clearTimeout(c.helloTimer);
    if (!c.id || this.clients.get(c.id) !== c) return;
    this.clients.delete(c.id);
    const g = this.groups.get(c.group);
    if (g) {
      g.delete(c);
      if (!g.size) this.groups.delete(c.group);
    }
    this.dropCodesOf(c.id);
    for (const vid of c.visible.keys()) {
      const v = this.clients.get(vid);
      if (v && v.visible.delete(c.id)) {
        this.log('info', 'visible.remove', { viewer: this.label(v.id), lost: this.label(c.id), why: 'offline' });
        v.send({ t: 'peer-left', id: c.id });
      }
    }
  }

  // ---- visibility ----

  /** Map of visible peer id -> via ('lan' | 'paired'). */
  visibleFor(c) {
    const out = new Map();
    for (const o of this.groups.get(c.group) || []) if (o !== c && o.id) out.set(o.id, 'lan');
    for (const lid of c.links) {
      if (out.has(lid)) continue;
      const o = this.clients.get(lid);
      if (o && o.links.has(c.id)) out.set(lid, 'paired'); // both sides must agree
    }
    return out;
  }

  /** Recompute visibility for c and everyone whose view of c may have changed. */
  refreshAround(c, oldLinks = new Set()) {
    const affected = new Set([c.id, ...c.visible.keys(), ...c.links, ...oldLinks]);
    for (const o of this.groups.get(c.group) || []) if (o.id) affected.add(o.id);
    for (const id of affected) {
      const x = this.clients.get(id);
      if (x) this.refresh(x);
    }
  }

  refresh(x) {
    const next = this.visibleFor(x);
    for (const [id, via] of next) {
      if (x.visible.get(id) !== via) {
        this.log('info', 'visible.add', { viewer: this.label(x.id), sees: this.label(id), via });
        x.send({ t: 'peer-joined', peer: this.peerInfo(this.clients.get(id), via) });
      }
    }
    for (const id of x.visible.keys()) {
      if (!next.has(id)) {
        this.log('info', 'visible.remove', { viewer: this.label(x.id), lost: this.label(id) });
        x.send({ t: 'peer-left', id });
      }
    }
    x.visible = next;
  }

  peerInfo(o, via) {
    return { id: o.id, name: o.name, kind: o.kind, pub: o.pub, via };
  }

  cleanLinks(ids, self) {
    const out = new Set();
    if (Array.isArray(ids)) for (const id of ids.slice(0, LINKS_MAX)) if (typeof id === 'string' && ID_RE.test(id) && id !== self) out.add(id);
    return out;
  }

  // ---- misc ----

  /** Debug lines a page sends when it runs with ?debug=1 (see web/js/log.js). */
  onClientLog(c, m) {
    if (!Array.isArray(m.lines)) return;
    for (const line of m.lines.slice(0, 60)) {
      if (typeof line !== 'string') continue;
      this.log('info', 'client', { dev: this.label(c.id), line: line.replace(/[\u0000-\u001f]/g, ' ').slice(0, 600) });
    }
  }

  /** "abcd1234/Quiet Fox" for log lines. */
  label(id) {
    const c = this.clients.get(id);
    return id ? id.slice(0, 8) + (c ? '/' + c.name : '') : '-';
  }

  iceFor(id) {
    const { stunUrls, turnUrls, turnSecret, turnTtl } = this.opts;
    const servers = [];
    if (stunUrls.length) servers.push({ urls: stunUrls });
    if (turnSecret && turnUrls.length) {
      const { username, credential, expiry } = turnCredentials(turnSecret, id, turnTtl);
      servers.push({ urls: turnUrls, username, credential });
      return { iceServers: servers, expires: expiry };
    }
    return { iceServers: servers, expires: Math.floor(Date.now() / 1000) + turnTtl };
  }

  dropCodesOf(id) {
    for (const [code, e] of this.codes) if (e.id === id) this.codes.delete(code);
  }

  sweep() {
    const now = Date.now();
    for (const [code, e] of this.codes) if (e.expires <= now) this.codes.delete(code);
    this.pairCreateLimit.sweep();
    this.pairJoinLimit.sweep();
    this.helloLimit.sweep();
  }

  dump() {
    return [...this.clients.values()].map((c) => ({
      dev: this.label(c.id), kind: c.kind, ip: c.ip, group: c.group, conn: c.cid,
      online: Math.round((Date.now() - c.t0) / 1000) + 's',
      sees: [...c.visible].map(([vid, via]) => `${this.label(vid)}(${via})`),
    }));
  }

  stats() {
    return { devices: this.clients.size, groups: this.groups.size, codes: this.codes.size };
  }
}

/** Summarize a signaling payload for logs: candidate types and protocols, never the full SDP. */
function describeSignal(kind, data) {
  try {
    const d = JSON.parse(data);
    if (kind === 'ice') {
      const cand = (d.c && d.c.candidate) || '';
      if (!cand) return { cand: 'end-of-candidates' };
      const m = cand.match(/ (udp|tcp) \d+ (\S+) (\d+) typ (\w+)/i);
      return m ? { cand: m[4], proto: m[1].toLowerCase(), addr: `${m[2]}:${m[3]}`, sess: d.sess } : { cand: 'unparsed' };
    }
    if (kind === 'offer' || kind === 'answer') {
      const sdp = String(d.sdp || '');
      const types = [...sdp.matchAll(/ typ (\w+)/g)].map((x) => x[1]);
      return { sess: d.sess, fingerprint: /a=fingerprint:/.test(sdp) ? 'yes' : 'MISSING', inlineCands: types.length ? types.join(',') : 'none(trickle)' };
    }
    return { sess: d.sess };
  } catch {
    return { parse: 'failed' };
  }
}

class Client {
  constructor(conn, ip, group, hub, cid) {
    this.hub = hub;
    this.cid = cid;
    this.t0 = Date.now();
    this.conn = conn;
    this.ip = ip;
    this.group = group;
    this.id = null;
    this.links = new Set();
    this.visible = new Map();
    this.closed = false;
    this.budget = { n: 0, since: Date.now() };
  }
  send(obj) {
    if (!this.closed) this.conn.send(JSON.stringify(obj));
  }
  tag() {
    return this.id ? { dev: this.hub.label(this.id) } : { conn: this.cid, ip: this.ip };
  }
  error(code, msg, extra) {
    this.hub.log(code === 'rate-limited' || code === 'bad-hello' ? 'warn' : 'info', 'reply.error', { ...this.tag(), code, msg });
    this.send({ t: 'error', code, msg, ...extra });
  }
  allowMessage() {
    const now = Date.now();
    if (now - this.budget.since > 10_000) this.budget = { n: 0, since: now };
    return ++this.budget.n <= 400; // ICE trickle can be chatty; this is generous
  }
}
