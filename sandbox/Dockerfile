# The secretary's sandbox: a small Linux box with common scripting tools.
# It holds no secrets, has a read-only root filesystem, and can reach only the
# public internet (see runner.mjs for the firewall and docker-compose.yml for the limits).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils procps grep sed gawk bc file jq sqlite3 zip unzip \
      ca-certificates curl wget git iptables \
      python3 python3-pip python3-venv python3-dateutil python3-requests \
      python3-pandas python3-matplotlib python3-openpyxl python3-docx python3-pypdf \
      poppler-utils ffmpeg imagemagick fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY runner.mjs /opt/sandbox/runner.mjs

# Starts as root only to set the firewall and switch each command to its group's unprivileged user.
USER root
CMD ["node", "/opt/sandbox/runner.mjs"]
