# VPS deploy notes

## Live deployment (October 2026)

- Page and WebSocket: **[https://mio.pantsu.uk](https://mio.pantsu.uk)** (`wss://mio.pantsu.uk/ws`), on port 443 alongside the host's other sites, selected by server name. Port 80 serves ACME challenges and redirects to HTTPS. Port 8443 was the first address and now only redirects (301) to the portless URL, so old links and installed PWAs keep working.
- nginx (custom build in `/usr/local/nginx`): `servers/mio.pantsu.uk.conf`, from `deploy/nginx-softdrop.conf`. nginx passes `X-Real-IP`. The app trusts that header only from loopback.
- App: `softdrop.service` (systemd, user `softdrop`, hardened). Runs `/opt/softdrop/server/src/index.js` on `127.0.0.1:8480` and serves `/opt/softdrop/web`. Config and the TURN secret live in `/etc/softdrop/softdrop.env` (root only). Redeploy with `sh deploy/install.sh`.
- coturn (Debian package): `/etc/turnserver.conf`, from `deploy/turnserver.conf` with the secret filled in. Ports 3478 udp/tcp and 5349 tcp (TLS). The relay range is **49160–49999/udp**, narrowed to stay clear of other services on the host.
- Certificate: Let's Encrypt for `mio.pantsu.uk` (webroot `/var/www/acme`, ECDSA), renewed by the existing certbot timer. The deploy hook `/etc/letsencrypt/renewal-hooks/deploy/coturn-softdrop.sh` copies it to `/etc/coturn/certs` and restarts coturn. The existing hook reloads nginx.
- Health: `curl https://mio.pantsu.uk/healthz` returns counts only, no IDs.
- Firewall: the host has no nftables or iptables rules. If the provider has a cloud firewall, open 80/tcp, 443/tcp, 8443/tcp (redirect only), 3478/udp+tcp, 5349/tcp and 49160–49999/udp.

### Logs

- Follow everything live: `sh deploy/logs.sh` (or `server`, `turn`, `dump` as the argument). It wraps `journalctl -u softdrop -u coturn`.
- The signaling server writes one line per event (`LEVEL event key=value …`). Events cover connect and disconnect, registration, who can see whom, every relayed signal (kind, size, ICE candidate type and address, never the SDP body or any file data), pairing (codes are masked), rate limits and error replies. `LOG_LEVEL=debug` in `/etc/softdrop/softdrop.env` also logs pings and HTTP requests.
- `sh deploy/logs.sh dump` (that is, `systemctl kill -s USR2 softdrop`) prints every online device and who it can see.
- **Page debug mode:** on by default for every visitor while testing (`DEBUG_DEFAULT` in `web/js/log.js`). `?debug=0` turns it off for one browser and `?debug=1` turns it back on; both are remembered. The page then shows a debug log panel and streams its lines to the server log as `client dev=… line=…`. It logs ICE candidates, connection states, the selected candidate pair with addresses and RTT, the DTLS fingerprint check, and transfer steps with speeds and hash results. This is the way to follow a phone, which has no console.
- coturn runs with `verbose`. Each relay session logs its allocation and a closing `usage:` line with packet and byte counts. Remove `verbose` from `/etc/turnserver.conf` when testing is over.

The notes below are the original generic plan.


Status: notes for the first deployment. Verify each setting against the current coturn and reverse-proxy documentation before relying on it.

## What runs on the VPS

| Service | Job | Ports |
| --- | --- | --- |
| Reverse proxy (Caddy or nginx) | HTTPS for the static page and the WebSocket endpoint | 443/tcp (80/tcp for certificates) |
| Signaling server | WebSocket routing, presence, pairing codes | local only, behind the proxy |
| coturn | STUN and TURN | 3478 udp+tcp, 5349 tcp (TLS), relay range 49152–65535 udp |

HTTPS is required. Service workers, the PWA install prompt and several browser APIs only work on a secure origin.

## DNS

- `drop.example.com` for the page and WebSocket (rename to your domain).
- `turn.example.com` for coturn, pointing at the same VPS. You can use one name for both if you prefer.

## coturn

Use time-limited credentials (the TURN REST scheme). The signaling server and coturn share one secret. The server creates a username of the form `<expiry-unix-time>:<deviceId>` and a password that is the base64 HMAC-SHA1 of that username with the shared secret. Send them to clients in `welcome.ice`.

Example `/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
min-port=49152
max-port=65535

realm=turn.example.com
use-auth-secret
static-auth-secret=CHANGE_ME_LONG_RANDOM_STRING

fingerprint
no-cli
no-multicast-peers

# Public IP when the VPS sits behind NAT (some clouds). Remove if the server has the public IP directly.
# external-ip=PUBLIC_IP/PRIVATE_IP

# TLS certificates for 5349 (same ones the proxy uses)
# cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
# pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Keep the relay from reaching private networks behind the VPS.
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255

# Cost and abuse limits
total-quota=100
user-quota=12
bps-capacity=0
```

Tune the quotas to your VPS bandwidth. Relay traffic counts against the VPS bandwidth allowance.

## ICE servers sent to clients

```json
{
  "iceServers": [
    { "urls": "stun:turn.example.com:3478" },
    {
      "urls": [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp"
      ],
      "username": "<expiry>:<deviceId>",
      "credential": "<base64 hmac>"
    }
  ]
}
```

Keep the TURN-over-TCP and TLS entries. Some Wi-Fi networks block UDP, and those entries are the fallback.

## Firewall

Open: 80/tcp, 443/tcp, 3478/tcp+udp, 5349/tcp, 49152–65535/udp. Keep the signaling server's own port closed to the internet and reachable only by the reverse proxy.

## Reverse proxy and client IP

The signaling server groups devices by public IP, so it needs the real client address. Configure the proxy to pass it (for example `X-Forwarded-For`), and make the server trust that header only when the connection comes from the proxy.

## Rough capacity thinking

Direct LAN transfers cost the VPS nothing. Only relayed transfers use VPS bandwidth, at one byte in and one byte out per byte sent. A small VPS handles signaling for a very large number of devices. Bandwidth, not CPU, is the limit for relay.

## Checklist before real use

- [ ] HTTPS works for the page and the WebSocket.
- [ ] Two devices on the same Wi-Fi find each other and show "Direct · same Wi-Fi".
- [ ] A phone on mobile data and a laptop on Wi-Fi connect through TURN and show "Via relay".
- [ ] TURN credentials expire (test with an old username).
- [ ] The relay cannot reach private ranges (`denied-peer-ip` is active).
- [ ] Pairing codes expire and are rate limited.
- [ ] Test on guest Wi-Fi with client isolation turned on, and check the fallback is quick.
