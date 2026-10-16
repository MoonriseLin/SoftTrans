import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Hub } from '../src/hub.js';
import { groupKey, b64url, turnCredentials } from '../src/util.js';

const subtle = webcrypto.subtle;

async function device(name) {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const id = b64url(await subtle.digest('SHA-256', pubRaw));
  const sign = async (text) => b64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(text)));
  return { name, id, pub: b64url(pubRaw), sign };
}

/** Connects a device to the hub and completes the challenge/hello handshake. */
async function join(hub, dev, ip, extra = {}) {
  const inbox = [];
  let closed = null;
  const conn = { send: (s) => inbox.push(JSON.parse(s)), close: (code) => (closed = code) };
  const h = hub.connect(conn, ip, groupKey(ip));
  const challenge = inbox.shift();
  assert.equal(challenge.t, 'challenge');
  const sig = await dev.sign(`softdrop/hello\n${challenge.nonce}\n${dev.id}`);
  await h.message(JSON.stringify({ t: 'hello', id: dev.id, name: dev.name, kind: 'Test', pub: dev.pub, sig, ...extra }));
  const take = (t) => {
    const i = inbox.findIndex((m) => m.t === t);
    return i < 0 ? null : inbox.splice(i, 1)[0];
  };
  return { ...h, inbox, take, send: (m) => h.message(JSON.stringify(m)), get closed() { return closed; } };
}

test('groups devices by public IP and announces joins and leaves', async () => {
  const hub = new Hub();
  const [a, b, c] = await Promise.all([device('A'), device('B'), device('C')]);
  const ca = await join(hub, a, '203.0.113.5');
  const wa = ca.take('welcome');
  assert.equal(wa.peers.length, 0);

  const cb = await join(hub, b, '203.0.113.5');
  const wb = cb.take('welcome');
  assert.deepEqual(wb.peers.map((p) => [p.id, p.via]), [[a.id, 'lan']]);
  assert.equal(ca.take('peer-joined').peer.id, b.id);

  const cc = await join(hub, c, '198.51.100.9');
  assert.equal(cc.take('welcome').peers.length, 0);
  assert.equal(ca.take('peer-joined'), null);

  cb.close();
  assert.equal(ca.take('peer-left').id, b.id);
  hub.close();
});

test('IPv6 clients group by /64', () => {
  assert.equal(groupKey('2001:db8:1:2:aaaa::1'), groupKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(groupKey('2001:db8:1:2::1'), groupKey('2001:db8:1:3::1'));
  assert.equal(groupKey('::ffff:192.0.2.1'), groupKey('192.0.2.1'));
});

test('rejects a hello whose id does not match the key or whose signature is wrong', async () => {
  const hub = new Hub();
  const [a, b] = await Promise.all([device('A'), device('B')]);
  const inbox = [];
  const h = hub.connect({ send: (s) => inbox.push(JSON.parse(s)), close() {} }, '192.0.2.1', groupKey('192.0.2.1'));
  const { nonce } = inbox.shift();
  // Claims A's id with B's key.
  await h.message(JSON.stringify({ t: 'hello', id: a.id, pub: b.pub, sig: await b.sign(`softdrop/hello\n${nonce}\n${a.id}`) }));
  assert.equal(inbox.shift().code, 'bad-hello');
  // Right key, signature over the wrong nonce.
  await h.message(JSON.stringify({ t: 'hello', id: a.id, pub: a.pub, sig: await a.sign(`softdrop/hello\nother\n${a.id}`) }));
  assert.equal(inbox.shift().code, 'bad-hello');
  assert.equal(hub.clients.size, 0);
  hub.close();
});

test('relays signals only between visible peers, verbatim', async () => {
  const hub = new Hub();
  const [a, b, c] = await Promise.all([device('A'), device('B'), device('C')]);
  const ca = await join(hub, a, '203.0.113.5');
  const cb = await join(hub, b, '203.0.113.5');
  const cc = await join(hub, c, '198.51.100.9');
  const msg = { t: 'signal', to: b.id, kind: 'offer', data: '{"sdp":"x"}', ts: 1, sig: 'abc' };
  await ca.send(msg);
  const got = cb.take('signal');
  assert.deepEqual(got, { t: 'signal', from: a.id, kind: 'offer', data: msg.data, ts: 1, sig: 'abc' });

  await cc.send({ ...msg, to: a.id });
  assert.equal(cc.take('error').code, 'unknown-peer');
  assert.equal(ca.take('signal'), null);
  hub.close();
});

test('pairing codes are single use and link devices across networks once both confirm', async () => {
  const hub = new Hub();
  const [a, b] = await Promise.all([device('A'), device('B')]);
  const ca = await join(hub, a, '203.0.113.5');
  const cb = await join(hub, b, '198.51.100.9');
  await ca.send({ t: 'pair-create' });
  const { code, ttl } = ca.take('pair-code');
  assert.match(code, /^\d{6}$/);
  assert.equal(ttl, 300);

  await ca.send({ t: 'pair-join', code });
  assert.equal(ca.take('error').code, 'own-code');

  await cb.send({ t: 'pair-join', code });
  assert.equal(ca.take('paired').peer.id, b.id);
  assert.equal(cb.take('paired').peer.pub, a.pub);

  await cb.send({ t: 'pair-join', code });
  assert.equal(cb.take('error').code, 'bad-code');

  // One-sided link: not visible yet.
  await ca.send({ t: 'links', ids: [b.id] });
  assert.equal(cb.take('peer-joined'), null);
  // Mutual: both see each other as paired.
  await cb.send({ t: 'links', ids: [a.id] });
  assert.equal(cb.take('peer-joined').peer.via, 'paired');
  assert.equal(ca.take('peer-joined').peer.id, b.id);

  // Unpair from one side hides both.
  await ca.send({ t: 'links', ids: [] });
  assert.equal(ca.take('peer-left').id, b.id);
  assert.equal(cb.take('peer-left').id, a.id);
  hub.close();
});

test('pair-join is rate limited per IP', async () => {
  const hub = new Hub();
  const a = await device('A');
  const ca = await join(hub, a, '203.0.113.5');
  const codes = [];
  for (let i = 0; i < 14; i++) {
    await ca.send({ t: 'pair-join', code: String(100000 + i) });
    codes.push(ca.take('error').code);
  }
  assert.ok(codes.slice(0, 12).every((c) => c === 'bad-code'));
  assert.equal(codes.at(-1), 'rate-limited');
  hub.close();
});

test('a second connection with the same device id replaces the first', async () => {
  const hub = new Hub();
  const [a, b] = await Promise.all([device('A'), device('B')]);
  const ca1 = await join(hub, a, '203.0.113.5');
  const cb = await join(hub, b, '203.0.113.5');
  const ca2 = await join(hub, a, '203.0.113.5');
  assert.equal(ca1.closed, 4001);
  assert.ok(cb.take('peer-left'));
  assert.ok(cb.take('peer-joined'));
  assert.equal(ca2.take('welcome').peers[0].id, b.id);
  hub.close();
});

test('TURN credentials follow the REST scheme', () => {
  const { username, credential, expiry } = turnCredentials('secret', 'dev', 60);
  assert.equal(username, `${expiry}:dev`);
  assert.ok(expiry > Date.now() / 1000);
  assert.match(credential, /^[A-Za-z0-9+/]+=*$/);
});
