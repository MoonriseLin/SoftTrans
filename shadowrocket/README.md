# Shadowrocket rules for SoftTrans

`sr_cnip_ad.conf` is [Johnshall/Shadowrocket-ADBlock-Rules-Forever](https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever) ("cnip + ad block": China direct, the rest proxied, ads rejected) with the SoftTrans rules from `softtrans.rules` added at the top of `[Rule]`.

**Install on the iPhone:** in Shadowrocket, go to Config → `+` and add `https://mio.pantsu.uk/rules/sr_cnip_ad.conf`. Select the new config, and set the routing mode to **Config** (rule-based). In Global mode, Shadowrocket ignores rules and sends everything through the proxy, which brings back the slow path.

**Why it is hosted here.** The original config's `update-url` points at the upstream file, so every Shadowrocket update replaced it with a copy without our lines. This copy's `update-url` points at itself. `build.sh` regenerates it daily from upstream (`softdrop-rules.timer`), so it stays current and keeps the SoftTrans rules.

**What the SoftTrans rules do:**

- `DOMAIN,mio.pantsu.uk` and `IP-CIDR,45.89.232.91/32` → DIRECT. Signaling matches by domain. STUN and TURN are raw packets to the server's IP with no hostname, so they need the IP rule. Without it they fall through to `FINAL,PROXY`.
- Private ranges → DIRECT, as a backstop. The upstream `bypass-tun` already keeps them, and `224.0.0.0/4` for mDNS, out of the tunnel.

`skip-proxy` already includes `*.local`, and `bypass-tun` covers `224.0.0.0/4`. The earlier hand-added `DOMAIN-SUFFIX,local` and `224.0.0.251` rules had no effect, so they were dropped.

Edit `softtrans.rules`, not `sr_cnip_ad.conf`. The latter is regenerated, and the copy here is only a snapshot.
