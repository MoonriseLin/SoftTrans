# Softdrop

**English** · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

Send files and text between your devices (phone to computer, laptop to tablet) from a web page. When the devices share a Wi-Fi network, data goes straight between them over the LAN. Everything is end-to-end encrypted. The server only introduces devices to each other and never sees what you send.

**Try it:** open **[https://mio.pantsu.uk](https://mio.pantsu.uk)** on two devices.

Nothing to install. On iPhone or Android you can add the page to your Home Screen and use it like an app (PWA). The interface is available in English, Simplified Chinese, Traditional Chinese and Japanese. It follows your browser's language, and the language you pick in the header is remembered.

---

## Using it

1. Open the page on both devices. If they are on the same Wi-Fi, each one appears on the other's radar within a second or two.
2. Tap the device you want to send to.
3. Type text, tap **Paste** to bring in whatever is on the clipboard (text or an image), or drop or choose files, then tap **Send**.
4. The other device starts receiving right away, with no confirmation step. Both sides show the progress as received / total size (for example `50.5 MB / 200.3 MB`) and the speed.
5. Each transfer shows how it travels:
   - **Direct · same Wi-Fi**: device to device on your local network. This is the fastest path, and it costs the server nothing.
   - **Direct**: device to device across the internet, via NAT traversal.
   - **Via relay**: through the server's relay. Used only when no direct path works. It is still end-to-end encrypted.

**Devices on different networks** (for example a phone on mobile data and a laptop at home) pair once:

1. On one device, tap **Get a code**. A 4-digit code appears, valid for 5 minutes.
2. Type the code on the other device and tap **Pair**. The two devices are paired right away.

From then on, the two devices find each other whenever both are online, on any network.

---

## How it works between devices

```
 Phone (browser / PWA)                                   Computer (browser)
        │                                                        │
        │ 1. WebSocket (WSS): register, find peers, swap signed  │
        │    connection offers                                   │
        └───────────────────────►  Server  ◄─────────────────────┘
                          signaling · STUN/TURN · the page

        2. WebRTC data channel, encrypted end to end (DTLS):
           a. direct over the LAN ................. preferred
           b. direct across NATs (STUN) ........... different networks
           c. through the TURN relay .............. last resort
```

### 1. Each device has its own identity

On first open, the browser creates an **ECDSA P-256 key pair** with WebCrypto. The private key cannot be exported, and it stays in the browser's IndexedDB. The **device ID is the SHA-256 hash of the public key**. Because the ID comes from the key, no one can claim another device's ID. Each device also gets a friendly random name such as "Quiet Fox", which you can change.

There are no accounts. Identity is per device (per browser).

### 2. Registering and finding nearby devices

The page opens a WebSocket to the server. The server sends a random challenge, and the device signs it with its private key. The server accepts the device only if the signature checks out and the ID matches the key.

The server then groups devices by the **public IP address** it sees. IPv6 addresses are grouped by their /64 prefix. Devices behind the same home router share a public IP, so they appear to each other as **nearby** without any setup. Behind a big shared NAT (offices, campuses, mobile carriers), strangers can land in the same group. Incoming transfers start without asking, so anyone in your group can send to you. The page always shows who is nearby and who each transfer is from.

**Paired devices** are visible to each other on any network. The server shows two devices to each other only when *both* say they trust the other. It keeps this only in memory and stores nothing on disk.

### 3. Setting up a direct connection (signaling)

Browsers can't connect to each other without first exchanging connection details. Those are the WebRTC **offer**, **answer** and **ICE candidates** (possible network addresses). The server passes these messages along, but it cannot forge them:

- Every message is **signed** with the sender's device key, and the receiver checks the signature before using it.
- The offer and answer include the fingerprint of the certificate that will encrypt the connection (DTLS). The fingerprint is covered by the signature, so it is pinned. After connecting, each side checks that the certificate actually used matches it.

As a result, neither a malicious server nor someone else on the Wi-Fi can slip into the middle and pose as one of your devices. For devices you have not paired, you are trusting the server to introduce the right device. Pairing stores the other device's public key, so later connections are checked against that key. Pairing itself trusts the server and the 4-digit code: there is no extra check number to compare.

### 4. Choosing the path

WebRTC's ICE tries every possible path at once and keeps the best one that works:

| Path | When it is used | Label |
| --- | --- | --- |
| LAN (host to host) | Same Wi-Fi, and the devices can reach each other | Direct · same Wi-Fi |
| STUN (NAT traversal) | Different networks whose routers allow it | Direct |
| TURN relay on the server | Strict NATs, guest Wi-Fi with client isolation, networks that block UDP | Via relay |

The label comes from the connection the browser actually selected (`getStats()`), so it reflects what is really happening. Relay devices also get a dashed ring on the radar. Relay logins are time-limited credentials minted by the server. The relay forwards encrypted packets and never writes them to disk.

### 5. Sending a file

Everything travels over one reliable, ordered **data channel**:

1. The sender announces the transfer with its name, size and type. Short text up to 16 KB travels inside this announcement.
2. The receiver accepts automatically and opens its storage.
3. The file is sent in **64 KB chunks**, or 16 KB if the other browser can't take larger messages. Sending uses backpressure, so a fast sender doesn't flood memory. The receiver reports progress, which drives the progress ring and speed shown on both sides.
4. Both sides compute a **SHA-256 hash** of the whole file. The receiver keeps the file only if the hashes match.
5. Large received files are written to the browser's private storage (OPFS) when it supports this, and otherwise kept as a Blob. Then you tap **Save**, or **Share** on phones.

Either side can cancel. If the connection drops in the middle (a phone screen locking, Wi-Fi changing), the transfer pauses. When the devices reconnect, it continues from where it stopped.

### What the server can and cannot see

| The server knows | The server never sees |
| --- | --- |
| Device IDs, names, device types and public IPs of connected devices | File contents or text you send |
| Which devices are paired with each other, while they are online | File names or sizes (they travel inside the encrypted channel) |
| That a connection was set up, and relayed byte counts when TURN is used | Your private keys |

There are no accounts, no tracking and no analytics.

---

## Good to know

- **Keep the page open on phones.** iOS and Android pause web pages in the background, which also pauses transfers. The page keeps the screen awake during a transfer where the browser allows it.
- **Guest and public Wi-Fi** often block device-to-device traffic (client isolation). Transfers then go through the relay, so they work but are slower.
- **Very large files on iPhone** can hit Safari's memory limits.
- Opening Softdrop in a second tab on the same browser moves the device to the newest tab.
- Add `?relay=1` to the address to force the relay path, which is useful for testing.
- **Debug log**: the page records each connection and transfer step and sends it to the server log. The log panel is hidden; add `?debug=1` to the address to show it. `?debug=0` stops recording. On the server, `sh deploy/logs.sh` follows the logs.

---

## For developers

```
server/      signaling server (Node 20 + ws): presence, IP grouping, pairing codes,
             signed signaling relay, TURN credentials
web/         the app, no build step: index.html, app.css, js/*.js, service worker,
             manifest, icons
  js/identity.js   device keys, trusted peers
  js/signaling.js  WebSocket client
  js/rtc.js        WebRTC links, signature checks, DTLS pinning, route detection
  js/transfer.js   transfer protocol (meta/accept/chunks/hash/cancel/resume)
  js/sinks.js      where received bytes are stored (OPFS or Blob)
  js/i18n.js       English, Simplified Chinese, Traditional Chinese, Japanese
e2e/         two-browser end-to-end test (Playwright)
deploy/      nginx site, systemd unit, coturn config, install script
prototype/   original front-end prototype (visual reference)
docs/        design plan, protocol (see "As built"), deploy notes
```

**Run locally**

```sh
cd server && npm install && npm start    # http://127.0.0.1:8480
npm test                                 # unit tests
```

Two browser profiles on the same machine (for example a normal window and a private one) see each other as nearby. Without `TURN_HOST` and `TURN_SECRET`, only direct paths work.

**End-to-end test**

```sh
cd e2e && npm install && npx playwright-core install chromium-headless-shell
node run.mjs                                       # against a local server
BASE=https://mio.pantsu.uk node run.mjs       # against production
QUERY='?relay=1' WANT_ROUTE=relay WANT_LABEL='Via relay' BASE=https://mio.pantsu.uk node run.mjs
```

**Deploy (on the VPS):** `sh deploy/install.sh`. See [docs/deploy-notes.md](docs/deploy-notes.md) for nginx, coturn and certificates, and [docs/protocol-draft.md](docs/protocol-draft.md) for the message formats.
