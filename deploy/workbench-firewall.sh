#!/usr/bin/env bash
# Host firewall for the binjaibot workbenches (SANDBOX_BACKEND=workbench, see sandbox/runner.mjs).
#
# Every group's workbench is a container on the docker network "binjaibot-workbench"
# (172.30.240.0/24, bridge br-binjai-wb), where commands run as root. This lets that network
# reach the public internet and nothing else:
#   - forwarded traffic (DOCKER-USER) to private, link-local (cloud metadata), carrier-NAT,
#     loopback, multicast and reserved addresses is rejected, and so is outbound mail;
#   - nothing arriving from the bridge may reach the host itself (INPUT), whatever listens there.
# DNS keeps working because workbenches use public resolvers (Docker's embedded DNS does not
# work under gVisor anyway).
#
# Idempotent: the rules live in dedicated chains that are rebuilt on every run, and the jumps
# into them are added only once. Run as root. To re-apply on boot (and whenever docker
# restarts), install the systemd unit next to this script:
#   sudo install -m 755 deploy/workbench-firewall.sh /usr/local/sbin/binjaibot-workbench-firewall.sh
#   sudo install -m 644 deploy/binjaibot-workbench-firewall.service /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now binjaibot-workbench-firewall.service
# To remove: delete the jumps (iptables -D DOCKER-USER/INPUT ...) and the BINJAI-WB* chains.
set -euo pipefail

SUBNET=172.30.240.0/24
BRIDGE=br-binjai-wb
FORWARD_CHAIN=BINJAI-WB
INPUT_CHAIN=BINJAI-WB-IN

BLOCKED_NETWORKS=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4
)
MAIL_PORTS=25,465,587

if [ "$(id -u)" != 0 ]; then
  echo "run as root" >&2
  exit 1
fi

# Append a jump at the top of a chain unless it is already there.
jump_first() {
  local tool=$1 parent=$2
  shift 2
  "$tool" -w -C "$parent" "$@" 2>/dev/null || "$tool" -w -I "$parent" 1 "$@"
}

# Docker creates DOCKER-USER when it starts; make sure it exists in any case.
iptables -w -N DOCKER-USER 2>/dev/null || true

# Rebuild both chains in one atomic step, so there is never a moment without rules.
{
  echo '*filter'
  echo ":$FORWARD_CHAIN - [0:0]"
  echo ":$INPUT_CHAIN - [0:0]"
  echo "-A $FORWARD_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
  for network in "${BLOCKED_NETWORKS[@]}"; do
    echo "-A $FORWARD_CHAIN -d $network -j REJECT --reject-with icmp-admin-prohibited"
  done
  echo "-A $FORWARD_CHAIN -p tcp -m multiport --dports $MAIL_PORTS -j REJECT --reject-with tcp-reset"
  echo "-A $INPUT_CHAIN -j REJECT --reject-with icmp-admin-prohibited"
  echo 'COMMIT'
} | iptables-restore -w --noflush

# Match the bridge as well as the subnet, so a forged source address does not slip past.
jump_first iptables DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN"
jump_first iptables DOCKER-USER -s "$SUBNET" -j "$FORWARD_CHAIN"
# First in INPUT: the host's own rules may accept ssh/http before their final reject.
jump_first iptables INPUT -i "$BRIDGE" -j "$INPUT_CHAIN"

# The network is IPv4 only. Should IPv6 ever show up on the bridge, it gets nothing.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -w -N DOCKER-USER 2>/dev/null || true
  {
    echo '*filter'
    echo ":$FORWARD_CHAIN - [0:0]"
    echo "-A $FORWARD_CHAIN -j REJECT"
    echo 'COMMIT'
  } | ip6tables-restore -w --noflush
  jump_first ip6tables DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN"
  jump_first ip6tables INPUT -i "$BRIDGE" -j "$FORWARD_CHAIN"
fi

echo "binjaibot workbench firewall applied for $SUBNET on $BRIDGE"
