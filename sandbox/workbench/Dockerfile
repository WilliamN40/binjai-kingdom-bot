# A group's workbench: its own long-lived Linux machine, one container per group, created and
# managed by the sandbox runner when SANDBOX_BACKEND=workbench (see ../runner.mjs).
#
# Commands run here as root and may apt-get install anything or leave services running. That is
# safe only because of what surrounds the container: the gVisor runtime (runsc) gives it its own
# kernel, and the host firewall (deploy/workbench-firewall.sh) lets its network reach the public
# internet only. The runner refuses to run commands if that firewall is missing.
#
# Build (on the host that runs the bot):
#   docker compose --profile image build workbench-image
# Running workbenches pick up a new build the next time their group is idle.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini bash coreutils findutils procps psmisc grep sed gawk bc file jq sqlite3 zip unzip less \
      ca-certificates curl wget gnupg git openssh-client \
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

# ntubus: live NTU campus shuttle buses, as a command for scripts and hooks and as an MCP
# server for the secretary (ntubus mcp). One file, no dependencies.
COPY ntubus/ntubus.mjs /opt/ntubus/ntubus.mjs
RUN chmod 755 /opt/ntubus/ntubus.mjs && ln -s /opt/ntubus/ntubus.mjs /usr/local/bin/ntubus

WORKDIR /work

# tini reaps the background processes that commands leave behind; the container itself just waits.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
