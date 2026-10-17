#!/bin/sh
# Follow Softdrop's logs live: the signaling server (including lines from pages opened
# with ?debug=1) and coturn (relay allocations). Run on the VPS:
#   sh deploy/logs.sh            follow everything
#   sh deploy/logs.sh server     only the signaling server
#   sh deploy/logs.sh turn       only coturn
#   sh deploy/logs.sh dump       print who is online right now, then exit
set -eu
case "${1:-all}" in
  server) exec journalctl -f -o short-iso -n 50 -u softdrop ;;
  turn)   exec journalctl -f -o short-iso -n 50 -u coturn ;;
  dump)   systemctl kill -s USR2 softdrop; sleep 0.5; exec journalctl -o cat -u softdrop --since "-5s" | grep -E "dump" ;;
  *)      exec journalctl -f -o short-iso -n 50 -u softdrop -u coturn ;;
esac
