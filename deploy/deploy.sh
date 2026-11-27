#!/usr/bin/env bash
# Deploys the commit the bot asked for (after the owner confirmed it in the chat).
#
# Runs on the host as root, started by binjaibot-deploy.service whenever
# data/deploy/request.json appears (see binjaibot-deploy.path). It checks out
# exactly that commit, rebuilds and restarts the containers, rolls back if the
# bot does not come up, and leaves data/deploy/result.json for the bot to post.
set -uo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/binjaibot}
APP_USER=${APP_USER:-ubuntu}
DIR="$APP_DIR/data/deploy"
REQUEST="$DIR/request.json"
WORK="$DIR/processing.json"
LOG="$DIR/last-deploy.log"

[ -f "$REQUEST" ] || exit 0
mv -f "$REQUEST" "$WORK"
: > "$LOG"

field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$WORK" "$1"; }
SHA=$(field sha)
CHAT=$(field chatId)
THREAD=$(field threadId)

git_as_app() { sudo -u "$APP_USER" git -C "$APP_DIR" "$@"; }
PREVIOUS=$(git_as_app rev-parse HEAD 2>/dev/null || echo "")

# result <true|false> <message>
result() {
  python3 - "$1" "$SHA" "$PREVIOUS" "$2" "$CHAT" "$THREAD" "$DIR/result.json" <<'EOF'
import json, sys, datetime
ok, sha, previous, message, chat, thread, out = sys.argv[1:8]
data = {"ok": ok == "true", "sha": sha, "previous": previous or None, "message": message[-1500:],
        "chatId": int(chat), "threadId": int(thread) if thread else None,
        "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
open(out + ".tmp", "w").write(json.dumps(data, indent=2))
import os; os.replace(out + ".tmp", out)
EOF
  rm -f "$WORK"
}

log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$LOG"; }
tail_log() { tail -c 1200 "$LOG"; }

if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$CHAT" =~ ^-?[0-9]+$ ]]; then
  result false "The deploy request was malformed."
  exit 1
fi

build_and_start() {
  cd "$APP_DIR" || return 1
  log "building"
  docker compose build >> "$LOG" 2>&1 || return 1
  if grep -q '^SANDBOX_BACKEND=workbench' .env 2>/dev/null; then
    docker compose --profile image build workbench-image >> "$LOG" 2>&1 || return 1
  fi
  log "starting"
  docker compose up -d >> "$LOG" 2>&1 || return 1
  # Healthy = the bot container is running and has not restarted for 30 seconds.
  sleep 30
  [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' binjaibot 2>/dev/null)" = "true 0" ]
}

log "fetching $SHA (running ${PREVIOUS:-unknown})"
if ! git_as_app fetch --quiet origin "$SHA" >> "$LOG" 2>&1 || ! git_as_app checkout --quiet -f --detach "$SHA" >> "$LOG" 2>&1; then
  result false "Could not fetch that commit from GitHub.
$(tail_log)"
  exit 1
fi

if build_and_start; then
  python3 -c 'import json,sys,datetime; open(sys.argv[1],"w").write(json.dumps({"sha":sys.argv[2],"deployedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}))' "$DIR/current.json" "$SHA"
  log "done"
  result true ""
  exit 0
fi

log "failed, rolling back to ${PREVIOUS:-nothing}"
FAILURE=$(tail_log)
if [ -n "$PREVIOUS" ]; then
  git_as_app checkout --quiet -f --detach "$PREVIOUS" >> "$LOG" 2>&1 && build_and_start || log "rollback did not come up cleanly either"
fi
result false "$FAILURE"
exit 1
