# Softdrop (working name)

Send files and text between devices on the same Wi-Fi, for example phone to computer, from a browser page. Transfers go over the LAN whenever possible. A VPS only coordinates the devices and relays data as a last resort.

"Softdrop" is a working name. Change it freely.

## Decisions already made

- **Both sides are web pages.** The computer uses a browser tab. The phone uses the same page as a PWA in Safari or Chrome. One codebase. There is no native iOS app, which avoids the US$99/year Apple Developer fee and the need for a Mac. Revisit a native app only if background transfers or push notifications become necessary.
- **Transport is WebRTC data channels.** ICE gathers host (LAN), STUN (public) and TURN (relay) candidates and prefers the LAN path when one works.
- **The VPS runs three things:** a signaling server (WebSocket), coturn (STUN and TURN), and static hosting for the page over HTTPS.
- **Data path priority:** direct LAN, then NAT traversal via STUN, then TURN relay on the VPS.
- **The VPS is untrusted.** Transfers are end-to-end encrypted, the server never sees plaintext, and it never stores transferred data.

## Current status

Build steps 1–5 and 7 are working, and step 6 is partly done. The app is deployed at **[https://mio.pantsu.uk](https://mio.pantsu.uk)** (step 8, minus testing on real phones and real networks).

- `server/`: signaling server in plain JavaScript (ESM) on Node 20 with `ws`. No build step. `npm test` runs the hub unit tests.
- `web/`: the live app, ported from the prototype. It uses no-build ES modules and serves under a strict CSP, so it has no inline scripts or styles.
- `e2e/run.mjs`: a two-browser Playwright test covering presence, text and file transfer, hash check, decline, cancel, pairing with SAS, and reload. It runs locally or against production, with an optional forced relay.
- `deploy/`: nginx, systemd and coturn configs, `install.sh`, and `logs.sh` to follow the logs.
- Debugging: `?debug=1` on the page shows a log panel and streams page logs to the server journal. Use `dlog()` from `web/js/log.js` for new client events. Server events go through `log()` in `server/src/log.js`. Never log file contents, keys or full pairing codes.
- `prototype/index.html` is still the visual reference. It is no longer the app.

Not done yet: resume after a page reload, tests on real phones and routers (iOS Safari especially), and auto-accept for paired devices. Signaling language decision: plain JS on Node.

Read these before building:

- `docs/design-plan.md` for layout and look.
- `docs/protocol-draft.md` for the message formats. The "As built" section describes the current behavior.
- `docs/deploy-notes.md` for the live deployment and the coturn config.

## Architecture

```
Phone (PWA) ──┐                         ┌── Computer (browser)
              │  1. register + signaling (WSS)
              └──────────► VPS ◄────────┘
                      signaling · STUN/TURN · static page

   2. direct LAN (ICE host candidates)   preferred
   3. STUN-assisted path                 different networks
   4. TURN relay through the VPS         last resort
```

Device grouping: the signaling server groups connections that share the same public IP as seen by the server. Those devices appear to each other automatically as "nearby". Devices on different networks pair with a 6-digit code instead.

## Design rules to keep when porting the prototype

- **Mood:** elegant and soft. Gentle, short wording ("Looking for devices nearby…", "Sent ✓").
- **Light theme:** warm off-white `#FBF6F1`, surfaces `#FFFDFB` and `#F5EBE3`, text `#3B2F2A`. No pure black.
- **Dark theme:** dusky blue-gray `#1E2230`, not black.
- **Accent:** one muted peach. `#F3AE95` for fills, `#A04E30` for accent text in light mode. Dark mode uses `#F4B093` and `#F7C3AB`.
- **Fonts:** Figtree for UI, Fraunces for the title only.
- **Shape:** large radii (22–30px), no hard borders, diffuse low-opacity shadows, tonal layers.
- **Motion:** spring-like easing (`cubic-bezier(.22,1,.36,1)`), 250–400 ms, nothing that snaps. Slow ripple on the radar, a gentle "breathing" glow on the drop zone. Respect `prefers-reduced-motion`.
- **Route label on every transfer:** "Direct · same Wi-Fi" (sage) or "Via relay" (peach). Relay devices get a dashed ring on the radar. This tells the user the LAN-first design is working and explains slowness.
- **Theme:** follows the system by default, with a manual system/light/dark toggle.
- **Languages:** English, Simplified Chinese, Traditional Chinese and Japanese, in `web/js/i18n.js`. The first visit follows the browser language, and the choice from the header picker is remembered in `localStorage` (`softdrop-lang`). Add every new UI string to all four dictionaries. Use `data-i18n` / `data-i18n-attr` in the HTML and `t()` in JS. Errors are stored as keys (`err.*`) and translated when shown.

## Build order

1. Signaling server: WebSocket, device presence, grouping by public IP, relaying offers, answers and ICE candidates.
2. WebRTC connection between two pages. Read `RTCPeerConnection.getStats()` for the selected candidate pair to drive the route label (host/host: "Direct · same Wi-Fi", srflx: "Direct", relay: "Via relay").
3. Data-channel transfer protocol: metadata, accept or reject, chunking with backpressure, hash check.
4. Pairing by 6-digit code for devices on different networks.
5. Device identity and end-to-end verification (keypairs, signed signaling, pinned DTLS fingerprint).
6. Resumable transfers, progress, cancel.
7. PWA: manifest and service worker (needs HTTPS), install prompt on iOS ("Add to Home Screen").
8. Deploy to the VPS and test on real phones and real networks.

Replace the simulated parts of the prototype one step at a time. Keep the UI working at each step.

## Known pitfalls

- **AP/client isolation** on guest or public Wi-Fi blocks device-to-device traffic. The direct path fails, so fall back to relay quickly instead of hanging.
- **Hidden local IPs.** Browsers hide LAN IPs behind mDNS names (`xxxx.local`) in ICE candidates. Two devices on the same Wi-Fi connect directly only if mDNS resolution works between them. If it does not, ICE falls back to a STUN-derived path (needs router hairpin NAT) or TURN. Test on real routers.
- **iOS Safari:** transfers stop when the page is backgrounded or the screen locks. Keep the page open and consider the Screen Wake Lock API during a transfer. Safari may show a Local Network permission prompt. Large files can hit memory limits when reassembled in the page, so write chunks to storage rather than holding everything in memory where possible.
- **Saving large received files:** streaming straight to a chosen file (`showSaveFilePicker`) works in desktop Chromium browsers but not in Safari. Plan a fallback such as the Origin Private File System or a Blob download, and verify browser support before relying on any of them.
- **Multiple network interfaces** (VPN, Docker, hotspot) create extra candidates. Let ICE choose, and judge the route from the selected pair.
- **Public-IP grouping** can group strangers behind a shared NAT (offices, campus networks, carrier-grade NAT). Always show who is nearby, and require the receiver to accept transfers from unknown devices.
- **IPv6:** devices on one home network may show different public IPv6 addresses. Group IPv6 clients by their /64 prefix.

## Security requirements

- End-to-end encryption through DTLS. Verify peer identity above that layer so a malicious VPS or a rogue device on the Wi-Fi cannot impersonate a peer.
- Each device holds a long-term keypair (WebCrypto, ECDSA P-256 for broad browser support). The device ID is derived from the public key.
- Sign signaling messages. Pin the DTLS fingerprint received in the signed offer and answer.
- Pairing exchanges and verifies public keys. Show a short authentication string or QR code on both sides.
- The receiver must accept an incoming transfer, at least for devices it has not paired with.
- Pairing codes: 6 digits, expire after 5 minutes, single use, rate limited per IP.
- TURN credentials are time-limited (REST style), generated by the signaling server. See `docs/deploy-notes.md`.
- Relay without storing: the VPS never writes transfer data to disk.

## Open questions

- Final product name and domain.
- The VPS is `mio.pantsu.uk` (Debian 13). Its region and relay latency from Tokyo have not been measured yet.
- Whether to add a native iOS app later (needs the paid Apple Developer account).
- Accounts: none planned. Identity is per device.

## Working agreements

- Keep the front end a plain web app that works without a build step as long as that stays practical. Add a bundler only when it earns its place.
- Do not add tracking or analytics.
- Ask before adding paid services or large dependencies.
