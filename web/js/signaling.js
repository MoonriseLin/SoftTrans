// WebSocket client for the signaling server: challenge/hello handshake,
// reconnects with backoff, keepalive. Emits every server message by its `t`.

import { dlog } from './log.js';

export class Signaling extends EventTarget {
  /** @param {import('./identity.js').Identity} me */
  constructor(me, url) {
    super();
    this.me = me;
    this.url = url;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | closed | replaced
    this.retry = 0;
    this.ice = null;
    this.iceAt = 0;
    this.queue = [];
  }

  start() {
    if (this.ws) return;
    this.setState('connecting');
    dlog('ws', 'connecting', { url: this.url, attempt: this.retry + 1 });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => {
      dlog('ws', 'closed', { code: e.code, reason: e.reason, clean: e.wasClean });
      this.ws = null;
      clearInterval(this.ping);
      if (e.code === 4001) {
        this.setState('replaced');
        return;
      }
      this.setState('closed');
      const wait = Math.min(15000, 600 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
      dlog('ws', 'retry scheduled', { inMs: Math.round(wait) });
      this.timer = setTimeout(() => this.start(), wait);
    };
  }

  /** Reconnect now (for example when the page becomes visible again). */
  kick() {
    if (this.state === 'replaced') this.retry = 0;
    if (this.ws || this.state === 'connecting') return;
    clearTimeout(this.timer);
    this.retry = 0;
    this.start();
  }

  setState(s) {
    if (this.state !== s) dlog('ws', 'state ' + this.state + ' -> ' + s);
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  async onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t !== 'pong' && m.t !== 'signal') dlog('ws', 'recv ' + m.t, summarize(m));
    if (m.t === 'challenge') {
      const sig = await this.me.sign(`softdrop/hello\n${m.nonce}\n${this.me.id}`);
      this.raw({
        t: 'hello', id: this.me.id, name: this.me.name, kind: this.me.kind, pub: this.me.pub,
        links: Object.keys(this.me.trusted), sig,
      });
      return;
    }
    if (m.t === 'welcome') {
      this.retry = 0;
      for (const s of (m.ice && m.ice.iceServers) || []) {
        dlog('ws', 'ice server', { urls: [].concat(s.urls).join(' '), auth: s.username ? 'turn-rest expires ' + new Date(m.ice.expires * 1000).toISOString() : 'none' });
      }
      this.setIce(m.ice);
      this.setState('open');
      clearInterval(this.ping);
      this.ping = setInterval(() => this.raw({ t: 'ping' }), 20000);
      const q = this.queue.splice(0);
      q.forEach((x) => this.raw(x));
    }
    if (m.t === 'ice') this.setIce(m.ice);
    if (m.t === 'error' && m.code === 'replaced') this.setState('replaced');
    this.dispatchEvent(new CustomEvent(m.t, { detail: m }));
  }

  setIce(ice) {
    this.ice = ice;
    this.iceAt = Date.now();
  }

  /** ICE servers, refreshing TURN credentials when they are close to expiry. */
  async iceServers() {
    if (this.ice && this.ice.expires * 1000 - Date.now() > 30 * 60 * 1000) return this.ice.iceServers;
    if (this.state === 'open') {
      const got = new Promise((resolve) => {
        const h = () => resolve();
        this.addEventListener('ice', h, { once: true });
        setTimeout(h, 3000);
      });
      this.raw({ t: 'ice' });
      await got;
    }
    return this.ice ? this.ice.iceServers : [];
  }

  raw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Send once registered; queued while reconnecting. */
  send(obj) {
    if (this.state === 'open') this.raw(obj);
    else if (obj.t !== 'signal') this.queue.push(obj);
  }

  /** Signed WebRTC signaling message to a peer. `data` is an object; it is sent as a signed JSON string. */
  async signal(to, kind, data) {
    const s = JSON.stringify(data);
    const ts = Date.now();
    const sig = await this.me.sign(signedText(this.me.id, to, kind, ts, s));
    dlog('sig', 'send ' + kind, { to: to.slice(0, 8), bytes: s.length, open: this.state === 'open' });
    this.send({ t: 'signal', to, kind, data: s, ts, sig });
  }
}

export function signedText(from, to, kind, ts, data) {
  return `softdrop/signal\n${from}\n${to}\n${kind}\n${ts}\n${data}`;
}

function summarize(m) {
  const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : id);
  switch (m.t) {
    case 'welcome': return { you: short(m.you && m.you.id), peers: (m.peers || []).map((p) => `${short(p.id)}/${p.name}(${p.via})`).join(', ') || 'none' };
    case 'peer-joined':
    case 'peer-updated': return { peer: `${short(m.peer.id)}/${m.peer.name}`, kind: m.peer.kind, via: m.peer.via };
    case 'peer-left': return { peer: short(m.id) };
    case 'error': return { code: m.code, msg: m.msg };
    case 'paired': return { peer: `${short(m.peer.id)}/${m.peer.name}` };
    case 'pair-code': return { ttl: m.ttl };
    default: return undefined;
  }
}
