# Softdrop

Send files and text between devices from a browser page. Transfers go over the same Wi-Fi when possible, and they are end-to-end encrypted.

Live: **https://mio.pantsu.uk:8443**. Open it on two devices.

```
server/      signaling server (Node 20, ws): presence, IP grouping, pairing codes, signed signaling relay, TURN creds
web/         the app (no build step): index.html, app.css, js/*.js, service worker, manifest, icons
e2e/         two-browser end-to-end test (Playwright)
deploy/      nginx site, systemd unit, coturn config, install script
prototype/   original front-end prototype (visual reference)
docs/        design plan, protocol (with "As built" notes), deploy notes
```

## Run locally

```sh
cd server && npm install && npm start      # http://127.0.0.1:8480 (localhost counts as a secure origin)
npm test                                   # hub unit tests
```

Two browser profiles (or a normal window and a private window) on the same machine see each other as "nearby". Without `TURN_HOST` and `TURN_SECRET` set, only direct paths work.

## Deploy (on the VPS)

```sh
sh deploy/install.sh   # copies to /opt/softdrop, installs deps, restarts softdrop.service
```

See `docs/deploy-notes.md` for nginx, coturn and certificates.

## Test end to end

```sh
cd e2e && npm install && npx playwright-core install chromium-headless-shell
node run.mjs                                            # starts a local server
BASE=https://mio.pantsu.uk:8443 node run.mjs            # against production
QUERY='?relay=1' WANT_ROUTE=relay WANT_LABEL='Via relay' BASE=https://mio.pantsu.uk:8443 node run.mjs
```
