# VPS deploy notes

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
