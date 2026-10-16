# Protocol draft

Status: draft. Written as a starting point for Claude Code, not a final spec. Change it as the build teaches you things.

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
| `pair-code` | `code`, `ttl` | A 6-digit code, valid for `ttl` seconds (300). |
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
