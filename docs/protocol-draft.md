# Protocol draft

Status: implemented in `server/` and `web/js/` (October 2026). Still open to change. The section "As built" at the end lists where the code differs from the first draft.

There are two layers: the signaling protocol (browser to VPS, over WebSocket) and the transfer protocol (browser to browser, over a WebRTC data channel).

## 1. Signaling (WSS)

Endpoint: `wss://<your-domain>/ws`. Every message is a JSON object with a `t` field naming its type. The server only routes. It never reads transfer data.

### Identity

Each device generates an ECDSA P-256 keypair with WebCrypto on first run and stores it in IndexedDB. The device ID is the base64url SHA-256 of the exported public key. The display name is a friendly random name such as "Quiet Fox", editable by the user.

### Client to server

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `id`, `name`, `kind`, `pub` | Register this device. `kind` is a short label such as "iPhone" or "MacBook". `pub` is the exported public key. |
| `signal` | `to`, `kind` (`offer`, `answer`, `ice`), `data`, `sig` | Ask the server to forward a WebRTC message to device `to`. `sig` is the sender's signature over the message. |
| `pair-create` | none | Ask for a pairing code. |
| `pair-join` | `code` | Join another device using its code. |
| `unpair` | `peer` | Forget a paired device. |
| `ping` | none | Keepalive. |

### Server to client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `you`, `peers`, `ice` | Accepted. `peers` lists devices in the same group (same public IP) and paired devices, each with `id`, `name`, `kind`, `pub`, `via` (`lan` or `paired`). `ice` carries STUN/TURN servers and short-lived credentials. |
| `peer-joined` | `peer` | A device appeared. |
| `peer-left` | `id` | A device disappeared. |
| `signal` | `from`, `kind`, `data`, `sig` | A forwarded message. The server never alters `data` or `sig`. |
| `pair-code` | `code`, `ttl` | A 4-digit code, valid for `ttl` seconds (300). |
| `paired` | `peer` | Pairing succeeded for both sides. |
| `error` | `code`, `msg` | For example `bad-code`, `rate-limited`, `unknown-peer`. |
| `pong` | none | Keepalive reply. |

### Grouping rule

Group sockets by the public IP the server sees. Behind a reverse proxy, read the client address from the proxy header and trust it only from the proxy. For IPv6, use the /64 prefix. A device can be in the "nearby" group and in paired links at the same time.

### Pairing flow

1. Device A sends `pair-create` and shows the code from `pair-code`.
2. Device B sends `pair-join` with that code.
3. The server sends `paired` to both, each carrying the other's `id`, `name` and `pub`.
4. Both devices show a short authentication string derived from both public keys (for example 4 emoji or 6 digits). The users confirm they match. Only then is the peer stored as trusted.
5. Codes are single use, expire after 300 seconds, and are rate limited per IP.

### Connection flow

1. A selects B in the UI. A creates an `RTCPeerConnection` with the `ice` servers from `welcome`.
2. A creates a data channel, then sends `signal` with `kind: "offer"`.
3. B answers with `kind: "answer"`. Both sides send `kind: "ice"` messages as candidates appear.
4. Each side verifies `sig` against the sender's public key, and checks that the DTLS fingerprint inside the SDP is covered by the signature.
5. When the channel opens, read `getStats()` to find the selected candidate pair and set the route label.

## 2. Transfer protocol (data channel)

One reliable, ordered data channel named `softdrop`. Text frames carry JSON control messages. Binary frames carry file chunks.

### Control messages (text frames)

| `t` | Fields | Meaning |
| --- | --- | --- |
| `meta` | `tid`, `kind` (`file` or `text`), `name`, `size`, `mime`, `count` | Sender announces a transfer. `tid` is a random transfer ID. For small text, include `body` and skip chunking. |
| `accept` | `tid`, `offset` | Receiver accepts. `offset` is where to start (0 for new, higher to resume). |
| `reject` | `tid`, `reason` | Receiver declines. |
| `done` | `tid`, `sha256` | Sender finished and sends the hash of the whole file. |
| `ok` | `tid` | Receiver verified the hash. |
| `fail` | `tid`, `reason` | Hash mismatch or write error. |
| `cancel` | `tid` | Either side stops the transfer. |
| `ack` | `tid`, `offset` | Optional progress report, used for resume and the sender's progress ring. |

### Chunk frames (binary)

Layout: `[4 bytes tid-index][8 bytes offset, big endian][payload]`. The 4-byte index is a small number assigned in `meta` so several transfers can share one channel.

Chunk size: start at 16 KiB, which is the safest size across browsers. Raise it only after testing, and never past `pc.sctp.maxMessageSize`. Sending uses backpressure: set `bufferedAmountLowThreshold` (for example 256 KiB), pause when `bufferedAmount` exceeds a high-water mark (for example 1 MiB), and resume on the `bufferedamountlow` event.

### Resume

The receiver remembers the highest contiguous offset per `tid` (IndexedDB). After a dropped connection, the sender sends `meta` again with the same `tid`, and the receiver answers `accept` with the stored `offset`. Transfers are abandoned after a timeout (for example 24 hours).

### Receiver policy

- Paired and trusted device: auto-accept can be a setting. Default is ask.
- Unknown device in the same group: always ask.
- Show name, size and route label ("Direct · same Wi-Fi" or "Via relay") in the prompt.

### Limits to decide

- Maximum file size on iOS Safari, given memory limits.
- Whether to send several files in one `meta` with a `count`, or one `meta` per file. The prototype uses one transfer per file.

## 3. Route label

After the channel opens, find the selected pair:

```js
const stats = await pc.getStats();
// find the 'transport' report, read selectedCandidatePairId,
// then the 'candidate-pair' report, then its local and remote 'candidate' reports.
```

| Local type | Remote type | Label |
| --- | --- | --- |
| `host` | `host` | Direct · same Wi-Fi |
| `srflx` or `prflx` | any non-relay | Direct |
| `relay` | any | Via relay |

The label can change if ICE restarts. Update the UI when it does.

## 4. As built (changes from the first draft)

**Registration.** The server opens with `challenge` `{nonce}`. The client answers `hello` `{id, name, kind, pub, links, sig}`. `sig` is the device key's ECDSA P-256/SHA-256 signature (IEEE P1363, base64url) over `softdrop/hello\n<nonce>\n<id>`. The server checks `id == base64url(SHA-256(raw pub))` and the signature, so nobody can register under another device's ID. A second connection with the same ID replaces the first (close code 4001).

**Paired devices without server storage.** `hello.links` and the `links` `{ids}` message list the device IDs this device trusts. The server shows two devices on different networks to each other only when *both* list each other. The server stores nothing on disk.

**Extra messages.** Client → server: `links` `{ids}`, `rename` `{name}`, `ice` (refresh TURN credentials), `pair-cancel`. Server → client: `peer-updated` `{peer}`, `ice` `{ice}`. Signal kinds: `offer`, `answer`, `ice`, `bye`.

**Signed signaling.** `signal` is `{to, kind, data, ts, sig}`. `data` is a JSON *string*, so the exact bytes are signed. `sig` covers `softdrop/signal\n<from>\n<to>\n<kind>\n<ts>\n<data>`. The receiver verifies it against the sender's public key (whose hash is the sender's ID) before using the message. It also drops messages more than 10 minutes old and replays of the same signature. Each `data` carries `sess`, a random session ID for one RTCPeerConnection. Glare is resolved by ID order: the device with the lower ID is polite and yields.

**DTLS pinning.** The `a=fingerprint` lines come from the signed SDP. When the channel opens, the remote certificate fingerprint from `getStats()` must be one of them, or the link is dropped.

**Data channel.** A pre-negotiated channel (`negotiated: true, id: 0`) named `softdrop`, so glare never leaves one side without a channel. Chunks are 64 KiB when `pc.sctp.maxMessageSize` allows it, and 16 KiB otherwise. On a 4-vCPU test VPS, 16 KiB messages topped out at about 3 MB/s and 64 KiB at about 20 MB/s. Backpressure: pause above 2 MiB buffered, resume at the 512 KiB `bufferedamountlow`. The receiver sends `ack` every 512 KiB. Text of 16 KiB or less travels inline in `meta.body`.

**Hashing.** SHA-256 over the whole payload, sent in `done`. The sender hashes the file in a separate pass. The receiver hashes incrementally as chunks arrive (`web/js/sha256.js`, because WebCrypto has no streaming digest).

**Storage.** Files over 4 MB are written to the Origin Private File System when `createWritable` exists (in batches of about 1 MB). Otherwise they are folded into a Blob every 8 MB. Leftover files are cleared on the next visit.

**Resume.** Resume works within a session: if the connection drops, both sides keep the transfer as `paused`. When the link reopens, the sender sends `meta` again with the same `tid`. The receiver answers `accept` with its byte offset, without asking the user again. Resume after a page reload is not implemented, because the sender loses access to the file.

**Route label.** `lan` = local host with remote host, or a peer-reflexive private address. `direct` = any other non-relay path. `relay` = either side relay. Labels: "Direct · same Wi-Fi", "Direct", "Via relay". The label is re-read every 4 s while the link is open.

**No pairing SAS.** Step 4 above is not built. When the server sends `paired`, both pages check that the ID matches the public key, then store the peer as trusted straight away. (A 6-digit SAS existed until October 2026 and was removed at the owner's request.)

**Auto-accept for paired devices.** For a paired sender the receiver sends `accept` as soon as `meta` arrives. Anyone else gets a `pending` item with Accept and Decline.

**Liveness and reconnect.** Either side may send `{t:'ping'}` on the data channel; the other answers `{t:'pong'}`. When a page becomes visible again, it pings every open link and drops any link that sends nothing back within 3 s (a phone that was locked). While any transfer with a peer is paused, the page keeps reconnecting (1.5 s doubling to 30 s); when the link opens, the sender re-offers and the receiver accepts at its current offset. Pairing codes are 4 digits (`pair-code`).

**Testing switch.** `?relay=1` in the page URL forces `iceTransportPolicy: 'relay'` for that device.
