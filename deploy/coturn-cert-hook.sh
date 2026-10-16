#!/bin/sh
# certbot deploy hook: give coturn (which runs unprivileged) a readable copy of the cert.
set -eu
case "${RENEWED_LINEAGE:-/etc/letsencrypt/live/mio.pantsu.uk}" in
  */mio.pantsu.uk) ;;
  *) exit 0 ;;
esac
SRC=/etc/letsencrypt/live/mio.pantsu.uk
install -d -m 0750 -o root -g turnserver /etc/coturn/certs
install -m 0644 -o root -g turnserver "$SRC/fullchain.pem" /etc/coturn/certs/fullchain.pem
install -m 0640 -o root -g turnserver "$SRC/privkey.pem" /etc/coturn/certs/privkey.pem
systemctl restart coturn || true
