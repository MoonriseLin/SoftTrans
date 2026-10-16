// WebRTC links between devices. Every signaling message is signed by the
// sender's device key and verified here before it touches the peer connection,
// so the DTLS fingerprint inside each SDP is pinned to the peer's identity:
// a malicious server or a rogue device on the Wi-Fi cannot swap in its own.

import { verify } from './identity.js';
import { signedText } from './signaling.js';

const CONNECT_TIMEOUT_MS = 20000;
const DISCONNECT_GRACE_MS = 4000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
// `?relay=1` forces TURN for this device's connections: handy for testing the relay path.
const FORCE_RELAY = new URLSearchParams(location.search).get('relay') === '1';

const rand = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

function sdpFingerprints(sdp) {
  const out = new Set();
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/gm)) out.add(m[1].toLowerCase() + ' ' + m[2].toUpperCase());
  return out;
}

function isPrivate(addr) {
  if (!addr) return false;
  if (addr.endsWith('.local')) return true; // mDNS-obfuscated host candidate
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i.test(addr);
}

/**
 * Route of the selected candidate pair:
 *  'lan'    host <-> host (or a peer-reflexive private address): same Wi-Fi
 *  'direct' a STUN-assisted path between networks
 *  'relay'  through TURN on the VPS
 */
export async function readRoute(pc) {
  const stats = await pc.getStats();
  let pair = null;
  let transport = null;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) transport = r;
  });
  if (transport) pair = stats.get(transport.selectedCandidatePairId);
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded')) && !pair) pair = r;
    });
  }
  if (!pair) return { route: null };
  const local = stats.get(pair.localCandidateId) || {};
  const remote = stats.get(pair.remoteCandidateId) || {};
  const lt = local.candidateType, rt = remote.candidateType;
  const laddr = local.address || local.ip, raddr = remote.address || remote.ip;
  let route = 'direct';
  if (lt === 'relay' || rt === 'relay') route = 'relay';
  else if (lt === 'host' && (rt === 'host' || (rt === 'prflx' && isPrivate(raddr)))) route = 'lan';
  else if (lt === 'prflx' && rt === 'host' && isPrivate(laddr)) route = 'lan';

  let remoteFp = null;
  if (transport && transport.remoteCertificateId) {
    const cert = stats.get(transport.remoteCertificateId);
    if (cert && cert.fingerprint) remoteFp = (cert.fingerprintAlgorithm || '').toLowerCase() + ' ' + cert.fingerprint.toUpperCase();
  }
  return { route, local: lt, remote: rt, protocol: local.protocol, remoteFp };
}

/** One RTCPeerConnection + the `softdrop` data channel to one peer. */
export class PeerLink extends EventTarget {
  constructor(mgr, peerId) {
    super();
    this.mgr = mgr;
    this.peerId = peerId;
    this.pc = null;
    this.dc = null;
    this.sess = null;
    this.offerer = false;
    this.route = null;
    this.state = 'idle'; // idle | connecting | open | closed | failed
    this.pendingIce = [];
    this.waiters = [];
    this.pinned = new Set();
    this.restarts = 0;
  }

  get polite() {
    return this.mgr.me.id < this.peerId;
  }

  setState(s, why) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: s, why } }));
    if (s === 'open') this.waiters.splice(0).forEach((w) => w.resolve(this.dc));
    if (s === 'failed' || s === 'closed') this.waiters.splice(0).forEach((w) => w.reject(new Error(why || s)));
  }

  /** Resolve with an open data channel, connecting if needed. */
  ready() {
    if (this.state === 'open' && this.dc && this.dc.readyState === 'open') return Promise.resolve(this.dc);
    const p = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (this.state !== 'connecting') this.start().catch((e) => this.fail(e.message));
    return p;
  }

  async newPc(sess) {
    this.teardown();
    this.sess = sess;
    this.route = null;
    this.pinned = new Set();
    this.pendingIce = [];
    this.setState('connecting');
    const iceServers = await this.mgr.sig.iceServers();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' });
    this.pc = pc;
    // Negotiated channel: both sides create it, so glare cannot leave one side without a channel.
    const dc = pc.createDataChannel('softdrop', { negotiated: true, id: 0, ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 512 * 1024;
    this.dc = dc;
    dc.onopen = () => this.onOpen(pc);
    dc.onclose = () => {
      if (this.pc === pc) this.lost('channel closed');
    };
    dc.onmessage = (e) => this.dispatchEvent(new CustomEvent('message', { detail: e.data }));
    pc.onicecandidate = (e) => {
      if (this.pc === pc && e.candidate) this.mgr.sig.signal(this.peerId, 'ice', { sess, c: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.onPcState(pc);
    pc.oniceconnectionstatechange = () => this.onPcState(pc);
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && this.state === 'connecting') this.fail('err.unreach');
    }, CONNECT_TIMEOUT_MS);
    return pc;
  }

  async start() {
    this.offerer = true;
    const pc = await this.newPc(rand());
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.mgr.sig.signal(this.peerId, 'offer', { sess: this.sess, sdp: pc.localDescription.sdp });
  }

  async restartIce() {
    const pc = this.pc;
    if (!pc || !this.offerer || this.restarts++ > 2) return this.fail('err.lost');
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await this.mgr.sig.signal(this.peerId, 'offer', { sess: this.sess, sdp: pc.localDescription.sdp });
  }

  /** A verified signaling message from the peer. */
  async handle(kind, d) {
    if (kind === 'bye') {
      if (d.sess === this.sess) this.close(false);
      return;
    }
    if (kind === 'offer') {
      const sameSession = this.pc && d.sess === this.sess;
      if (!sameSession && this.pc && this.pc.signalingState === 'have-local-offer') {
        // Both sides offered at once. The impolite side keeps its own offer.
        if (!this.polite) return;
      }
      const pc = sameSession ? this.pc : await this.newPc(d.sess);
      if (!sameSession) this.offerer = false;
      this.pinSdp(d.sdp);
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      await this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.mgr.sig.signal(this.peerId, 'answer', { sess: this.sess, sdp: pc.localDescription.sdp });
      return;
    }
    if (d.sess !== this.sess || !this.pc) return;
    if (kind === 'answer') {
      if (this.pc.signalingState !== 'have-local-offer') return;
      this.pinSdp(d.sdp);
      await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      await this.flushIce();
    } else if (kind === 'ice') {
      if (!this.pc.remoteDescription) this.pendingIce.push(d.c);
      else await this.pc.addIceCandidate(d.c).catch(() => {});
    }
  }

  pinSdp(sdp) {
    const fps = sdpFingerprints(sdp);
    if (!fps.size) throw new Error('SDP without DTLS fingerprint');
    this.pinned = fps;
  }

  async flushIce() {
    const list = this.pendingIce.splice(0);
    for (const c of list) await this.pc.addIceCandidate(c).catch(() => {});
  }

  async onOpen(pc) {
    const info = await readRoute(pc).catch(() => ({ route: null }));
    if (this.pc !== pc) return;
    // Defense in depth: the certificate DTLS actually used must be one the signed SDP named.
    if (info.remoteFp && this.pinned.size && !this.pinned.has(info.remoteFp)) {
      this.fail('err.cert');
      return;
    }
    clearTimeout(this.connectTimer);
    this.restarts = 0;
    this.setRoute(info.route);
    this.setState('open');
    clearInterval(this.routeTimer);
    this.routeTimer = setInterval(async () => {
      if (this.pc !== pc || this.state !== 'open') return;
      const r = await readRoute(pc).catch(() => null);
      if (r && r.route) this.setRoute(r.route);
    }, 4000);
  }

  setRoute(r) {
    if (!r || r === this.route) return;
    this.route = r;
    this.dispatchEvent(new CustomEvent('route', { detail: r }));
  }

  onPcState(pc) {
    if (this.pc !== pc) return;
    const s = pc.connectionState || pc.iceConnectionState;
    if (s === 'failed') {
      if (this.offerer && this.state === 'open') this.restartIce().catch(() => this.fail('err.lost'));
      else if (this.state === 'connecting') this.fail('err.unreach');
      else this.lost('connection failed');
    } else if (s === 'disconnected') {
      clearTimeout(this.discTimer);
      this.discTimer = setTimeout(() => {
        if (this.pc === pc && (pc.connectionState || pc.iceConnectionState) === 'disconnected' && this.offerer) {
          this.restartIce().catch(() => this.fail('err.lost'));
        }
      }, DISCONNECT_GRACE_MS);
    } else if (s === 'connected') {
      clearTimeout(this.discTimer);
    } else if (s === 'closed') {
      this.lost('closed');
    }
  }

  lost(why) {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.teardown();
    this.setState('closed', why);
  }

  fail(why) {
    this.teardown();
    this.setState('failed', why);
  }

  send(data) {
    this.dc.send(data);
  }

  /** Wait until the channel's send buffer drains below its low-water mark. */
  drain(highWater = 1024 * 1024) {
    const dc = this.dc;
    if (!dc || dc.bufferedAmount <= highWater) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        dc.removeEventListener('close', done);
        if (dc.readyState === 'open') resolve();
        else reject(new Error('channel closed'));
      };
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
    });
  }

  teardown() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.discTimer);
    clearInterval(this.routeTimer);
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    if (pc) {
      try { pc.close(); } catch {}
    }
  }

  close(tell = true) {
    if (tell && this.sess) this.mgr.sig.signal(this.peerId, 'bye', { sess: this.sess });
    this.teardown();
    this.setState('closed', 'closed');
  }
}

/** Owns all links, verifies signatures on incoming signaling. */
export class PeerManager extends EventTarget {
  /**
   * @param {import('./signaling.js').Signaling} sig
   * @param {import('./identity.js').Identity} me
   * @param {(id: string) => ({id: string, pub: string} | null)} lookup verified peer key by device id
   */
  constructor(sig, me, lookup) {
    super();
    this.sig = sig;
    this.me = me;
    this.lookup = lookup;
    this.links = new Map();
    this.seen = new Set();
    this.chain = Promise.resolve();
    // Process strictly in arrival order: an ICE candidate must not overtake its offer.
    sig.addEventListener('signal', (e) => {
      this.chain = this.chain.then(() => this.onSignal(e.detail)).catch((err) => console.warn('softdrop: signal', err));
    });
  }

  get(id) {
    let l = this.links.get(id);
    if (!l) {
      l = new PeerLink(this, id);
      this.links.set(id, l);
      this.dispatchEvent(new CustomEvent('link', { detail: l }));
    }
    return l;
  }

  async onSignal(m) {
    const peer = this.lookup(m.from);
    if (!peer) return;
    if (Math.abs(Date.now() - m.ts) > CLOCK_SKEW_MS) return console.warn('softdrop: stale signal from', m.from);
    if (this.seen.has(m.sig)) return; // replay
    const ok = await verify(peer.pub, m.sig, signedText(m.from, this.me.id, m.kind, m.ts, m.data));
    if (!ok) return console.warn('softdrop: bad signature from', m.from);
    this.seen.add(m.sig);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    let data;
    try {
      data = JSON.parse(m.data);
    } catch {
      return;
    }
    const link = this.get(m.from);
    try {
      await link.handle(m.kind, data);
    } catch (e) {
      console.warn('softdrop: signaling', e);
      link.fail('err.setup');
    }
  }

  drop(id) {
    const l = this.links.get(id);
    if (l) {
      l.close();
      this.links.delete(id);
    }
  }
}
