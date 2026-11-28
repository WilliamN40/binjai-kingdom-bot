# The secretary's sandbox: a small Linux box with common scripting tools and a headless browser.
# It holds no secrets, has a read-only root filesystem, and can reach only the
# public internet (see runner.mjs for the firewall and docker-compose.yml for the limits).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils procps grep sed gawk bc file jq sqlite3 zip unzip \
      ca-certificates curl wget git openssh-client iptables \
      python3 python3-pip python3-venv python3-dateutil python3-requests \
      python3-pandas python3-matplotlib python3-openpyxl python3-docx python3-pypdf \
      poppler-utils ffmpeg imagemagick fonts-dejavu-core chromium \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI, from GitHub's own package repository
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The docker CLI, used only with SANDBOX_BACKEND=workbench to manage the groups' workbench
# containers (see runner.mjs). A static binary; the daemon is the host's.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker

# ntubus: live NTU campus shuttle buses, as a command for scripts and hooks and as an MCP
# server for the secretary (ntubus mcp). One file, no dependencies.
COPY workbench/ntubus/ntubus.mjs /opt/ntubus/ntubus.mjs
RUN chmod 755 /opt/ntubus/ntubus.mjs && ln -s /opt/ntubus/ntubus.mjs /usr/local/bin/ntubus

COPY runner.mjs /opt/sandbox/runner.mjs

# Starts as root only to set the firewall and switch each command to its group's unprivileged user
# (local backend), or to manage the workbench containers (workbench backend).
USER root
CMD ["node", "/opt/sandbox/runner.mjs"]
