#!/bin/sh
# Copy the app to /opt/softdrop and restart it. Run as root from the repo root:
#   sh deploy/install.sh
set -eu
cd "$(dirname "$0")/.."
id softdrop >/dev/null 2>&1 || useradd --system --home /opt/softdrop --shell /usr/sbin/nologin softdrop
install -d -m 0755 /opt/softdrop /opt/softdrop/server
rm -rf /opt/softdrop/server/src /opt/softdrop/web /opt/softdrop/shadowrocket
cp -a server/src server/package.json server/package-lock.json /opt/softdrop/server/
cp -a web /opt/softdrop/web
cp -a shadowrocket /opt/softdrop/shadowrocket
(cd /opt/softdrop/server && npm ci --omit=dev --no-audit --no-fund --silent)
chown -R root:root /opt/softdrop
install -m 0644 deploy/softdrop.service /etc/systemd/system/softdrop.service
install -m 0644 deploy/softdrop-rules.service deploy/softdrop-rules.timer /etc/systemd/system/
install -m 0644 deploy/logrotate-nginx /etc/logrotate.d/nginx
install -d -m 0755 /var/www/softdrop-rules
systemctl daemon-reload
systemctl enable --now softdrop-rules.timer
systemctl enable --now softdrop
systemctl restart softdrop
sleep 1
curl -fsS http://127.0.0.1:8480/healthz && echo
