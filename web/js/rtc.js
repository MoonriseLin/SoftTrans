// WebRTC links between devices. Every signaling message is signed by the
// sender's device key and verified here before it touches the peer connection,
// so the DTLS fingerprint inside each SDP is pinned to the peer's identity:
// a malicious server or a rogue device on the Wi-Fi cannot swap in its own.

import { verify } from './identity.js';
import { signedText } from './signaling.js';
import { dlog } from './log.js';

const CONNECT_TIMEOUT_MS = 20000;
const DISCONNECT_GRACE_MS = 4000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
// A hairpin through a home router is a few ms; through a VPN exit it is far more.
const HAIRPIN_LAN_RTT_MS = 30;
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
/**
 * ctx.remoteHostPorts: ports of host candidates the peer signaled.
 * ctx.localPublic / ctx.remotePublic: public IPs from each side's srflx candidates.
 */
export async function readRoute(pc, ctx = {}) {
  const remoteHostPorts = ctx.remoteHostPorts || new Set();
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
  // A check can arrive before the peer's host candidate is signaled. The browser then
  // records it as peer-reflexive and may hide its address, but the port still matches
  // one of the host candidates the peer sent us: that is the same LAN path.
  const rtHost = rt === 'host' || (rt === 'prflx' && remote.port != null && remoteHostPorts.has(Number(remote.port)));
  let route = 'direct';
  if (lt === 'relay' || rt === 'relay') route = 'relay';
  else if (lt === 'host' && (rtHost || (rt === 'prflx' && isPrivate(raddr)))) route = 'lan';
  // Our side shows up as peer-reflexive (common when a VPN adds interfaces), but we reached
  // the peer's host candidate: host candidates are only reachable on the local network.
  else if (lt === 'prflx' && (rtHost || isPrivate(laddr))) route = 'lan';
  // Hairpin: when local addresses can't be resolved (mDNS blocked), ICE often connects
  // through the shared public address. If both sides share it, packets turn around at
  // that NAT. That is the home router only if the round trip is short: when both devices
  // sit behind the same VPN or proxy exit, the "shared public IP" is a server far away
  // (seen in testing: 155-233 ms), and calling that "same Wi-Fi" would be wrong.
  const rttMs = pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;
  let hairpin = false;
  if (route === 'direct' && ['srflx', 'prflx'].includes(lt) && ['srflx', 'prflx'].includes(rt) && ctx.localPublic && ctx.remotePublic) {
    for (const ip of ctx.localPublic) if (ctx.remotePublic.has(ip)) hairpin = true;
    if (hairpin && rttMs != null && rttMs <= HAIRPIN_LAN_RTT_MS) route = 'lan';
  }

  // Too early to tell: the peer answered from an address it has not announced yet (often its
  // IPv6 host candidate, signaled a few ms after the IPv4 one). Calling it "direct" here flips
  // to "same Wi-Fi" a moment later, so the caller waits (up to 3 s) for the candidate to arrive.
  const unsure = route === 'direct' && rt === 'prflx' && !rtHost;

  let remoteFp = null;
  if (transport && transport.remoteCertificateId) {
    const cert = stats.get(transport.remoteCertificateId);
    if (cert && cert.fingerprint) remoteFp = (cert.fingerprintAlgorithm || '').toLowerCase() + ' ' + cert.fingerprint.toUpperCase();
  }
  // Every pair ICE got an answer on, with its RTT: shows whether another path would be faster.
  // `tried` counts all pairs by type and state, and `remoteHosts` shows whether the peer's
  // mDNS (.local) host candidates were resolved: tells "name lookup blocked" from "routing".
  const alive = [];
  const tried = {};
  const remoteHosts = [];
  stats.forEach((r) => {
    if (r.type === 'remote-candidate' && r.candidateType === 'host') {
      const a = r.address || r.ip || '';
      remoteHosts.push(!a ? 'hidden' : a.endsWith('.local') ? 'unresolved' : isPrivate(a) ? 'private-ip' : 'public-ip');
    }
    if (r.type !== 'candidate-pair') return;
    const lc = stats.get(r.localCandidateId) || {}, rc = stats.get(r.remoteCandidateId) || {};
    const k = `${lc.candidateType}/${rc.candidateType}:${r.state}`;
    tried[k] = (tried[k] || 0) + 1;
    if (r.state !== 'succeeded') return;
    const l = stats.get(r.localCandidateId) || {}, m = stats.get(r.remoteCandidateId) || {};
    alive.push(`${l.candidateType}/${m.candidateType}${r.currentRoundTripTime != null ? ':' + Math.round(r.currentRoundTripTime * 1000) + 'ms' : ''}${r === pair ? '*' : ''}`);
  });
  return {
    route, unsure, hairpin, alive: alive.join(' ') || 'none',
    tried: Object.entries(tried).map(([k, n]) => (n > 1 ? `${k}x${n}` : k)).join(' '),
    remoteHosts: remoteHosts.join(',') || 'none', local: lt, remote: rt === 'prflx' && rtHost ? 'prflx=host' : rt, protocol: local.protocol, remoteFp,
    localAddr: laddr && `${laddr}:${local.port}`, remoteAddr: raddr && `${raddr}:${remote.port}`,
    relayProto: local.relayProtocol, rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
    sent: pair.bytesSent, recv: pair.bytesReceived,
  };
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
    this.remoteHostPorts = new Set();
    this.localPublic = new Set();
    this.remotePublic = new Set();
  }

  get short() {
    return this.peerId.slice(0, 8);
  }

  get polite() {
    return this.mgr.me.id < this.peerId;
  }

  setState(s, why) {
    if (this.state === s) return;
    dlog('rtc', `link ${this.short} ${this.state} -> ${s}`, { why });
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
    this.remoteHostPorts = new Set();
    this.localPublic = new Set();
    this.remotePublic = new Set();
    this.pendingIce = [];
    this.setState('connecting');
    const iceServers = await this.mgr.sig.iceServers();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' });
    dlog('rtc', `new pc ${this.short}`, {
      sess, role: this.offerer ? 'offerer' : 'answerer', polite: this.polite, policy: FORCE_RELAY ? 'relay-only' : 'all',
      servers: iceServers.map((x) => [].concat(x.urls).join(' ')).join(' | ') || 'none',
    });
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0) + 'ms';
    pc.onicegatheringstatechange = () => dlog('rtc', `gathering ${pc.iceGatheringState}`, { peer: this.short, at: ms() });
    pc.onsignalingstatechange = () => dlog('rtc', `signaling ${pc.signalingState}`, { peer: this.short });
    pc.onicecandidateerror = (e) => dlog('rtc', 'candidate error', { peer: this.short, url: e.url, code: e.errorCode, text: e.errorText, at: ms() });
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
    dc.onmessage = (e) => {
      this.lastRx = performance.now();
      this.dispatchEvent(new CustomEvent('message', { detail: e.data }));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const ci = candInfo(e.candidate.candidate);
        if (ci.type === 'srflx' && ci.addr) this.localPublic.add(ipOf(ci.addr));
        dlog('rtc', 'local candidate', { peer: this.short, ...ci, at: ms() });
      }
      else dlog('rtc', 'local candidates done', { peer: this.short, at: ms() });
      if (this.pc === pc && e.candidate) this.mgr.sig.signal(this.peerId, 'ice', { sess, c: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      dlog('rtc', `connection ${pc.connectionState}`, { peer: this.short, at: ms() });
      this.onPcState(pc);
    };
    pc.oniceconnectionstatechange = () => {
      dlog('rtc', `ice ${pc.iceConnectionState}`, { peer: this.short, at: ms() });
      this.onPcState(pc);
    };
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && this.state === 'connecting') {
        dlog('rtc', 'connect timeout', { peer: this.short, ms: CONNECT_TIMEOUT_MS, ice: pc.iceConnectionState, gathering: pc.iceGatheringState });
        this.fail('err.unreach');
      }
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
    dlog('rtc', 'ice restart', { peer: this.short, attempt: this.restarts + 1, offerer: this.offerer });
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
        dlog('rtc', 'glare', { peer: this.short, polite: this.polite, action: this.polite ? 'yield to their offer' : 'keep mine' });
        if (!this.polite) return;
      }
      const pc = sameSession ? this.pc : await this.newPc(d.sess);
      if (!sameSession) this.offerer = false;
      dlog('rtc', sameSession ? 'renegotiation offer (ice restart)' : 'incoming offer', { peer: this.short, sess: d.sess, cands: sdpCands(d.sdp) });
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
      if (this.pc.signalingState !== 'have-local-offer') return dlog('rtc', 'answer ignored', { peer: this.short, state: this.pc.signalingState });
      dlog('rtc', 'answer received', { peer: this.short, cands: sdpCands(d.sdp) });
      this.pinSdp(d.sdp);
      await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      await this.flushIce();
    } else if (kind === 'ice') {
      const ci = candInfo(d.c && d.c.candidate);
      if (ci.type === 'host' && ci.addr) this.remoteHostPorts.add(Number(ci.addr.split(':').pop()));
      if (ci.type === 'srflx' && ci.addr) this.remotePublic.add(ipOf(ci.addr));
      dlog('rtc', 'remote candidate', { peer: this.short, ...ci, queued: !this.pc.remoteDescription });
      if (!this.pc.remoteDescription) this.pendingIce.push(d.c);
      // The route label waits for exactly this when it was unsure: place it as soon as the candidate is in.
      if (ci.type === 'host' && this.unsureRecheck) setTimeout(this.unsureRecheck, 100);
      else await this.pc.addIceCandidate(d.c).catch((e) => dlog('rtc', 'addIceCandidate failed', { peer: this.short, err: e.message }));
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
    const info = await readRoute(pc, this).catch(() => ({ route: null }));
    if (this.pc !== pc) return;
    // Defense in depth: the certificate DTLS actually used must be one the signed SDP named.
    dlog('rtc', 'channel open', {
      peer: this.short, route: info.route + (info.hairpin ? (info.route === 'lan' ? ' (hairpin via home router)' : ' (hairpin via a far NAT: VPN or proxy exit?)') : ''), pair: `${info.local}/${info.remote}`, proto: info.protocol, relayProto: info.relayProto,
      local: info.localAddr, remote: info.remoteAddr, rtt: info.rtt != null ? info.rtt + 'ms' : undefined,
      maxMsg: pc.sctp && pc.sctp.maxMessageSize, alivePairs: info.alive,
      triedPairs: info.route === 'lan' ? undefined : info.tried, remoteHosts: info.route === 'lan' ? undefined : info.remoteHosts,
      unsure: info.unsure || undefined,
      dtls: !info.remoteFp ? 'fingerprint not in stats (skipped)' : this.pinned.has(info.remoteFp) ? 'pinned fingerprint matches' : 'MISMATCH',
    });
    if (info.remoteFp && this.pinned.size && !this.pinned.has(info.remoteFp)) {
      this.fail('err.cert');
      return;
    }
    clearTimeout(this.connectTimer);
    this.restarts = 0;
    this.farHairpin = !!(info.hairpin && info.route !== 'lan');
    // While the route is unsure, show no label rather than a wrong one, for up to 3 s.
    const unsureUntil = performance.now() + 3000;
    if (!info.unsure) this.setRoute(info.route);
    this.setState('open');
    clearInterval(this.routeTimer);
    const recheck = async () => {
      if (this.pc !== pc || this.state !== 'open') return;
      const r = await readRoute(pc, this).catch(() => null);
      if (r && r.route && !(r.unsure && performance.now() < unsureUntil)) {
        if (!r.unsure) this.unsureRecheck = null;
        if (r.route !== this.route || `${r.localAddr}>${r.remoteAddr}` !== this.lastPair) {
          dlog('rtc', 'selected pair changed', { peer: this.short, route: r.route + (r.hairpin ? (r.route === 'lan' ? ' (hairpin via home router)' : ' (hairpin via a far NAT: VPN or proxy exit?)') : ''), pair: `${r.local}/${r.remote}`, local: r.localAddr, remote: r.remoteAddr, rtt: r.rtt, alivePairs: r.alive });
        }
        this.lastPair = `${r.localAddr}>${r.remoteAddr}`;
        const far = !!(r.hairpin && r.route !== 'lan');
        if (far !== this.farHairpin) {
          this.farHairpin = far;
          this.dispatchEvent(new CustomEvent('route', { detail: r.route }));
        }
        this.setRoute(r.route);
      }
    };
    // Candidates often finish arriving just after the channel opens: look again soon.
    this.unsureRecheck = info.unsure ? recheck : null;
    if (info.unsure) setTimeout(recheck, 3050); // give up waiting: label with what we have
    setTimeout(recheck, 1200);
    this.routeTimer = setInterval(recheck, 4000);
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
    dlog('rtc', 'link lost', { peer: this.short, why });
    this.teardown();
    this.setState('closed', why);
  }

  fail(why) {
    dlog('rtc', 'link failed', { peer: this.short, why, ice: this.pc && this.pc.iceConnectionState });
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
    this.unsureRecheck = null;
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
    if (!peer) return dlog('sig', 'DROP signal from unknown device', { from: m.from.slice(0, 8), kind: m.kind });
    const from = m.from.slice(0, 8);
    if (Math.abs(Date.now() - m.ts) > CLOCK_SKEW_MS) return dlog('sig', 'DROP stale signal', { from, kind: m.kind, skewMs: Date.now() - m.ts });
    if (this.seen.has(m.sig)) return dlog('sig', 'DROP replayed signal', { from, kind: m.kind });
    const ok = await verify(peer.pub, m.sig, signedText(m.from, this.me.id, m.kind, m.ts, m.data));
    if (!ok) return dlog('sig', 'DROP bad signature', { from, kind: m.kind });
    dlog('sig', 'recv ' + m.kind + ' (signature ok)', { from, bytes: m.data.length });
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

function candInfo(c) {
  if (!c) return { type: 'end' };
  const m = c.match(/ (udp|tcp) \d+ (\S+) (\d+) typ (\w+)(?:.* tcptype (\w+))?/i);
  return m ? { type: m[4], proto: m[1].toLowerCase() + (m[5] ? '/' + m[5] : ''), addr: `${m[2]}:${m[3]}` } : { raw: c.slice(0, 80) };
}

function sdpCands(sdp) {
  const t = [...String(sdp).matchAll(/ typ (\w+)/g)].map((x) => x[1]);
  return t.length ? t.join(',') : 'trickle';
}

function ipOf(addr) {
  const i = addr.lastIndexOf(':');
  return i > 0 ? addr.slice(0, i) : addr;
}
