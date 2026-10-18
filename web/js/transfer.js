// Transfer protocol over the `softdrop` data channel (see docs/protocol-draft.md).
// Text frames: JSON control messages. Binary frames: [u32 idx][u64 offset][payload].

import { Sha256, hashBlob } from './sha256.js';
import { createSink } from './sinks.js';
import { dlog } from './log.js';

// 64 KiB per frame when the peer's SCTP stack allows it (many times faster than
// 16 KiB on slow CPUs), else the 16 KiB size every browser accepts.
const CHUNK_MAX = 64 * 1024;
const CHUNK_SAFE = 16 * 1024;
const READ_SLICE = 1024 * 1024;
const HIGH_WATER = 2 * 1024 * 1024;
const ACK_EVERY = 512 * 1024;
const INLINE_TEXT_MAX = 16 * 1024;
const HEADER = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function tidNew() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// A link that does not answer a ping this fast after the page comes back is treated as dead.
const PROBE_MS = 3000;

/**
 * Transfer object shared with the UI:
 * { tid, dir: 'in'|'out', peer, kind: 'file'|'text', name, size, mime, status, done (bytes), speed (B/s), route, error, file?, text? }
 * status: waiting | offered | pending | active | paused | verifying | done | rejected | canceled | failed
 */
export class TransferEngine extends EventTarget {
  /**
   * @param {import('./rtc.js').PeerManager} peers
   * @param {(peerId: string) => boolean} trusted incoming transfers from these peers start without asking
   */
  constructor(peers, trusted = () => false) {
    super();
    this.peers = peers;
    this.trusted = trusted;
    this.reconnects = new Map(); // peer -> { timer, attempt }
    this.all = new Map(); // tid -> transfer
    this.byIdx = new Map(); // `${peer}:${idx}` -> incoming transfer
    this.nextIdx = 1;
    this.wired = new WeakSet();
    peers.addEventListener('link', (e) => this.wire(e.detail));
  }

  emit(t) {
    if (t.status !== t.loggedStatus) {
      dlog('xfer', `${t.dir} ${t.kind} ${t.loggedStatus || 'new'} -> ${t.status}`, {
        tid: t.tid.slice(0, 8), name: t.kind === 'file' ? t.name : undefined, size: t.size, done: t.done,
        peer: t.peer.slice(0, 8), route: t.route, error: t.error,
        speed: t.speed ? (t.speed / 1e6).toFixed(2) + 'MB/s' : undefined,
        secs: t.t0 && !isLive(t) ? ((performance.now() - t.t0) / 1000).toFixed(1) : undefined,
      });
      t.loggedStatus = t.status;
    }
    this.dispatchEvent(new CustomEvent('update', { detail: t }));
  }

  wire(link) {
    if (this.wired.has(link)) return;
    this.wired.add(link);
    let chain = Promise.resolve();
    link.addEventListener('message', (e) => {
      const data = e.detail;
      chain = chain.then(() => this.onMessage(link, data)).catch((err) => console.warn('softdrop: transfer', err));
    });
    link.addEventListener('state', (e) => {
      const s = e.detail.state;
      if (s === 'open') this.onLinkOpen(link);
      else this.onLinkDown(link);
    });
    link.addEventListener('route', () => {
      for (const t of this.all.values()) if (t.peer === link.peerId && isLive(t)) { t.route = link.route; this.emit(t); }
    });
  }

  // ---------- sending ----------

  sendFile(peer, file) {
    return this.queueOut({ kind: 'file', name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream', file }, peer);
  }

  sendText(peer, text) {
    const bytes = enc.encode(text);
    return this.queueOut({ kind: 'text', name: 'Text message', size: bytes.length, mime: 'text/plain;charset=utf-8', text, bytes }, peer);
  }

  queueOut(o, peer) {
    const t = { tid: tidNew(), idx: this.nextIdx++, dir: 'out', peer, status: 'waiting', done: 0, speed: 0, route: null, created: Date.now(), ...o };
    if (t.kind === 'file') {
      t.abort = new AbortController();
      t.hashP = hashBlob(t.file, { signal: t.abort.signal });
      t.hashP.catch(() => {});
    }
    this.all.set(t.tid, t);
    this.emit(t);
    this.offer(t);
    return t;
  }

  async offer(t) {
    const link = this.peers.get(t.peer);
    try {
      await link.ready();
    } catch (e) {
      if (t.status === 'waiting' || t.status === 'paused') {
        t.status = 'paused';
        t.error = e.message;
        this.emit(t);
      }
      return;
    }
    if (!isLive(t)) return;
    t.route = link.route;
    t.status = t.status === 'paused' && t.started ? 'paused' : 'offered';
    t.error = null;
    const meta = { t: 'meta', tid: t.tid, idx: t.idx, kind: t.kind, name: t.name, size: t.size, mime: t.mime };
    if (t.kind === 'text' && t.size <= INLINE_TEXT_MAX) meta.body = t.text;
    this.ctl(link, meta);
    dlog('xfer', 'out meta sent', { tid: t.tid.slice(0, 8), kind: t.kind, size: t.size, resume: !!t.started });
    this.emit(t);
  }

  async pump(link, t, offset) {
    t.status = 'active';
    t.started = true;
    t.sending = (t.sending || 0) + 1;
    const run = t.sending;
    t.done = Math.max(t.done, offset);
    this.emit(t);
    const src = t.kind === 'file' ? t.file : new Blob([t.bytes]);
    const dc = link.dc;
    const max = link.pc && link.pc.sctp && link.pc.sctp.maxMessageSize;
    const CHUNK = max && max >= CHUNK_MAX + HEADER ? CHUNK_MAX : max && max > HEADER + 1024 ? Math.min(CHUNK_SAFE, max - HEADER) : CHUNK_SAFE;
    dlog('xfer', 'out sending', { tid: t.tid.slice(0, 8), fromOffset: offset, chunk: CHUNK, peerMaxMsg: max, route: link.route });
    try {
      for (let off = offset; off < t.size; ) {
        const slice = new Uint8Array(await src.slice(off, Math.min(t.size, off + READ_SLICE)).arrayBuffer());
        for (let i = 0; i < slice.length; i += CHUNK) {
          if (t.sending !== run || t.status !== 'active' || link.dc !== dc) return;
          await link.drain(HIGH_WATER);
          if (t.sending !== run || t.status !== 'active' || link.dc !== dc) return;
          const part = slice.subarray(i, i + CHUNK);
          const frame = new Uint8Array(HEADER + part.length);
          const dv = new DataView(frame.buffer);
          const at = off + i;
          dv.setUint32(0, t.idx);
          dv.setUint32(4, Math.floor(at / 0x100000000));
          dv.setUint32(8, at >>> 0);
          frame.set(part, HEADER);
          link.send(frame.buffer);
        }
        off += slice.length;
      }
      const sha256 = t.kind === 'file' ? await t.hashP : new Sha256().update(t.bytes).hex();
      if (t.sending !== run || t.status !== 'active') return;
      this.ctl(link, { t: 'done', tid: t.tid, sha256 });
      dlog('xfer', 'out all bytes sent, waiting for hash check', { tid: t.tid.slice(0, 8), sha256: sha256.slice(0, 16) });
      t.status = 'verifying';
      this.emit(t);
    } catch (e) {
      if (t.status === 'active') this.pause(t, e.message);
    }
  }

  // ---------- receiving ----------

  accept(t) {
    if (t.dir !== 'in' || t.status !== 'pending') return;
    const link = this.peers.links.get(t.peer);
    if (!link || link.state !== 'open') {
      t.error = 'err.waitConn';
      this.emit(t);
      return;
    }
    t.error = null;
    t.status = 'active';
    t.started = true;
    t.t0 = performance.now();
    this.emit(t);
    if (t.inline != null) {
      t.text = t.inline;
      t.done = t.size;
      t.status = 'done';
      this.ctl(link, { t: 'accept', tid: t.tid, offset: 0 });
      this.ctl(link, { t: 'ok', tid: t.tid });
      this.emit(t);
      return;
    }
    t.hash = new Sha256();
    t.sinkP = t.kind === 'file' ? createSink(t.tid, t.mime, t.size) : Promise.resolve(null);
    t.sinkP.then((sk) => dlog('xfer', 'in storage', { tid: t.tid.slice(0, 8), sink: sk ? sk.constructor.name : 'text-memory' }), () => {});
    t.textParts = t.kind === 'text' ? [] : null;
    this.ctl(link, { t: 'accept', tid: t.tid, offset: 0 });
  }

  reject(t) {
    if (t.dir !== 'in' || t.status !== 'pending') return;
    t.status = 'rejected';
    const link = this.peers.links.get(t.peer);
    if (link && link.state === 'open') this.ctl(link, { t: 'reject', tid: t.tid, reason: 'declined' });
    this.emit(t);
  }

  cancel(t) {
    if (!isLive(t)) return;
    t.status = 'canceled';
    t.sending = -1;
    if (t.abort) t.abort.abort();
    const link = this.peers.links.get(t.peer);
    if (link && link.state === 'open') this.ctl(link, { t: 'cancel', tid: t.tid });
    this.cleanup(t);
    this.emit(t);
  }

  async onChunk(link, buf) {
    const dv = new DataView(buf);
    const idx = dv.getUint32(0);
    const at = dv.getUint32(4) * 0x100000000 + dv.getUint32(8);
    const t = this.byIdx.get(link.peerId + ':' + idx);
    if (!t || t.status !== 'active') return;
    const part = new Uint8Array(buf, HEADER);
    if (at !== t.done || t.done + part.length > t.size) return this.failIn(link, t, 'err.order');
    const sink = await t.sinkP;
    try {
      if (sink) await sink.write(part);
      else t.textParts.push(part.slice());
    } catch (e) {
      return this.failIn(link, t, 'err.save');
    }
    t.hash.update(part);
    t.done += part.length;
    this.measure(t);
    if (t.done - (t.ackedAt || 0) >= ACK_EVERY || t.done === t.size) {
      t.ackedAt = t.done;
      this.ctl(link, { t: 'ack', tid: t.tid, offset: t.done });
    }
    this.emitSoon(t);
  }

  async onDone(link, t, sha256) {
    if (t.dir !== 'in' || t.status !== 'active') return;
    if (t.done !== t.size) return this.failIn(link, t, 'err.early');
    t.status = 'verifying';
    this.emit(t);
    const mine = t.hash.hex();
    dlog('xfer', mine === sha256 ? 'in hash ok' : 'in HASH MISMATCH', { tid: t.tid.slice(0, 8), mine: mine.slice(0, 16), theirs: String(sha256).slice(0, 16) });
    if (mine !== sha256) return this.failIn(link, t, 'err.hash');
    if (t.kind === 'file') {
      const sink = await t.sinkP;
      t.file = await sink.finish(t.name);
      t.sinkDone = true;
    } else {
      const all = new Uint8Array(t.size);
      let o = 0;
      for (const p of t.textParts) { all.set(p, o); o += p.length; }
      t.text = dec.decode(all);
      t.textParts = null;
    }
    t.status = 'done';
    this.ctl(link, { t: 'ok', tid: t.tid });
    this.emit(t);
  }

  failIn(link, t, why) {
    t.status = 'failed';
    t.error = why;
    this.ctl(link, { t: 'fail', tid: t.tid, reason: why });
    this.cleanup(t);
    this.emit(t);
  }

  // ---------- control ----------

  ctl(link, msg) {
    try {
      link.send(JSON.stringify(msg));
    } catch {}
  }

  async onMessage(link, data) {
    if (data instanceof ArrayBuffer) return this.onChunk(link, data);
    if (typeof data !== 'string') return;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === 'meta') {
      dlog('xfer', 'in meta', { tid: String(m.tid).slice(0, 8), kind: m.kind, size: m.size, mime: m.mime, inline: typeof m.body === 'string', known: this.all.has(m.tid) });
      return this.onMeta(link, m);
    }
    if (m.t === 'ping') return this.ctl(link, { t: 'pong' });
    if (m.t === 'pong') return;
    if (m.t !== 'ack') dlog('xfer', 'ctl ' + m.t, { tid: String(m.tid).slice(0, 8), offset: m.offset, reason: m.reason });
    const t = this.all.get(m.tid);
    if (!t || t.peer !== link.peerId) return;
    switch (m.t) {
      case 'accept':
        if (t.dir === 'out' && (t.status === 'offered' || t.status === 'paused')) {
          if (t.kind === 'text' && t.size <= INLINE_TEXT_MAX) {
            t.status = 'verifying';
            this.emit(t);
          } else {
            t.t0 = performance.now();
            t.speedBase = { at: t.t0, bytes: Number(m.offset) || 0 };
            this.pump(link, t, Math.max(0, Math.min(t.size, Number(m.offset) || 0)));
          }
        }
        break;
      case 'reject':
        if (t.dir === 'out' && isLive(t)) { t.status = 'rejected'; this.cleanup(t); this.emit(t); }
        break;
      case 'ack':
        if (t.dir === 'out' && isLive(t)) { t.done = Math.min(t.size, Number(m.offset) || 0); this.measure(t); this.emitSoon(t); }
        break;
      case 'done':
        return this.onDone(link, t, m.sha256);
      case 'ok':
        if (t.dir === 'out' && isLive(t)) { t.done = t.size; t.status = 'done'; this.cleanup(t); this.emit(t); }
        break;
      case 'fail':
        if (isLive(t)) { t.status = 'failed'; t.error = m.reason || 'err.remote'; this.cleanup(t); this.emit(t); }
        break;
      case 'cancel':
        if (isLive(t)) { t.status = 'canceled'; t.sending = -1; this.cleanup(t); this.emit(t); }
        break;
    }
  }

  onMeta(link, m) {
    if (typeof m.tid !== 'string' || !/^[0-9a-f]{24}$/.test(m.tid)) return;
    const existing = this.all.get(m.tid);
    if (existing) {
      // The sender reconnected and is offering again: resume where we stopped.
      if (existing.dir !== 'in' || existing.peer !== link.peerId) return;
      if (existing.status === 'done') {
        this.ctl(link, { t: 'ok', tid: existing.tid }); // we finished; the sender missed our ok
      } else if (existing.status === 'paused' && existing.started) {
        this.byIdx.set(link.peerId + ':' + m.idx, existing);
        existing.idx = m.idx;
        existing.status = 'active';
        existing.route = link.route;
        existing.error = null;
        existing.speedBase = { at: performance.now(), bytes: existing.done };
        this.ctl(link, { t: 'accept', tid: existing.tid, offset: existing.done });
        this.emit(existing);
      } else if (existing.status === 'pending') {
        this.byIdx.set(link.peerId + ':' + m.idx, existing);
        existing.idx = m.idx;
        if (this.trusted(link.peerId)) this.accept(existing);
      }
      return;
    }
    const size = Number(m.size);
    if (!Number.isSafeInteger(size) || size < 0) return;
    const t = {
      tid: m.tid, idx: m.idx >>> 0, dir: 'in', peer: link.peerId, route: link.route,
      kind: m.kind === 'text' ? 'text' : 'file',
      name: String(m.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file',
      size, mime: String(m.mime || '').slice(0, 100), status: 'pending', done: 0, speed: 0, created: Date.now(),
      inline: typeof m.body === 'string' && m.kind === 'text' && m.body.length <= INLINE_TEXT_MAX ? m.body : null,
    };
    this.all.set(t.tid, t);
    this.byIdx.set(link.peerId + ':' + t.idx, t);
    this.emit(t);
    // Paired devices send without asking; anyone else waits for Accept.
    if (this.trusted(link.peerId)) {
      dlog('xfer', 'in auto-accept (paired)', { tid: t.tid.slice(0, 8) });
      this.accept(t);
    }
  }

  /**
   * While a transfer with this peer is paused, keep trying to reconnect (1.5 s, 3 s, 6 s … up to 30 s).
   * Without this, a link that died while the peer stayed online (a locked phone) never came back.
   */
  keepReconnecting(peer) {
    const r = this.reconnects.get(peer) || { attempt: 0 };
    clearTimeout(r.timer);
    const paused = () => [...this.all.values()].some((t) => t.peer === peer && t.status === 'paused');
    if (!paused()) { this.reconnects.delete(peer); return; }
    const delay = Math.min(30000, 1500 * 2 ** r.attempt);
    r.timer = setTimeout(() => {
      const link = this.peers.get(peer);
      if (!paused() || link.state === 'open' || link.state === 'connecting') return;
      r.attempt++;
      dlog('xfer', 'reconnecting for paused transfers', { peer: peer.slice(0, 8), attempt: r.attempt });
      link.ready().catch(() => this.keepReconnecting(peer));
    }, delay);
    this.reconnects.set(peer, r);
  }

  onLinkOpen(link) {
    const r = this.reconnects.get(link.peerId);
    if (r) { clearTimeout(r.timer); this.reconnects.delete(link.peerId); }
    const waiting = [...this.all.values()].filter((t) => t.peer === link.peerId && t.dir === 'out' && (t.status === 'paused' || t.status === 'waiting')).length;
    if (waiting) dlog('xfer', 'link open: re-offering', { peer: link.peerId.slice(0, 8), transfers: waiting });
    for (const t of this.all.values()) {
      if (t.peer !== link.peerId) continue;
      if (t.dir === 'out' && (t.status === 'paused' || t.status === 'waiting')) this.offer(t);
    }
  }

  onLinkDown(link) {
    for (const t of this.all.values()) {
      if (t.peer !== link.peerId) continue;
      if (t.status === 'active' || t.status === 'offered' || (t.status === 'verifying' && t.dir === 'out')) this.pause(t, 'err.lost');
    }
    this.keepReconnecting(link.peerId);
  }

  /**
   * After the page was hidden (a locked phone), a link can look open while it is dead.
   * Ping every open link; one that does not answer within PROBE_MS is dropped at once,
   * so paused transfers reconnect in seconds instead of after the ~20 s ICE timeout.
   */
  probeLinks() {
    for (const link of this.peers.links.values()) {
      if (link.state !== 'open' || !link.dc) continue;
      const dc = link.dc;
      const sentAt = performance.now();
      this.ctl(link, { t: 'ping' });
      setTimeout(() => {
        if (link.dc === dc && link.state === 'open' && !(link.lastRx > sentAt)) {
          dlog('xfer', 'no answer to ping after resume: reconnecting', { peer: link.short });
          link.lost('no answer after resume');
        }
      }, PROBE_MS);
    }
  }

  pause(t, why) {
    t.status = 'paused';
    t.sending = -1;
    t.error = why;
    t.speed = 0;
    this.emit(t);
  }

  /** Retry paused outgoing transfers to a peer (for example when it shows up again). */
  retry(peer) {
    dlog('xfer', 'peer back: retry paused', { peer: peer.slice(0, 8) });
    for (const t of this.all.values()) if (t.peer === peer && t.dir === 'out' && t.status === 'paused') this.offer(t);
  }

  /** The peer went away for good (left, or unpaired). */
  peerGone(peer) {
    for (const t of this.all.values()) {
      if (t.peer === peer && t.dir === 'in' && t.status === 'pending') { t.status = 'canceled'; t.error = 'err.left'; this.emit(t); }
    }
  }

  measure(t) {
    const now = performance.now();
    if (!t.speedBase) t.speedBase = { at: now, bytes: t.done };
    const dt = (now - t.speedBase.at) / 1000;
    if (dt >= 0.5) {
      const inst = (t.done - t.speedBase.bytes) / dt;
      t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      t.speedBase = { at: now, bytes: t.done };
    }
  }

  emitSoon(t) {
    const tenth = t.size ? Math.floor((t.done / t.size) * 10) : 10;
    if (tenth !== t.loggedTenth) {
      t.loggedTenth = tenth;
      if (tenth > 0 && tenth < 10) dlog('xfer', `${t.dir} progress ${tenth * 10}%`, { tid: t.tid.slice(0, 8), done: t.done, speed: (t.speed / 1e6).toFixed(2) + 'MB/s', route: t.route });
    }
    if (t.emitTimer) return;
    t.emitTimer = setTimeout(() => {
      t.emitTimer = null;
      this.emit(t);
    }, 120);
  }

  async cleanup(t) {
    if (t.abort) t.abort.abort();
    if (t.dir === 'in' && t.sinkP && !t.sinkDone) {
      const s = await t.sinkP.catch(() => null);
      if (s) s.discard();
    }
  }

  get busy() {
    for (const t of this.all.values()) if (t.status === 'active' || t.status === 'verifying') return true;
    return false;
  }
}

export function isLive(t) {
  return !['done', 'rejected', 'canceled', 'failed'].includes(t.status);
}
