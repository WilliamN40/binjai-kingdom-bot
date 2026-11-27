#!/usr/bin/env bash
# One-time setup on the host so the owner can deploy from the chat with /deploy.
#
#   sudo APP_DIR=/home/ubuntu/binjaibot APP_USER=ubuntu bash deploy/install-deployer.sh [<commit or branch>]
#
# Makes APP_DIR a git checkout of the bot's repository (keeping data/ and .env,
# which git ignores), installs the systemd units that run deploy.sh when the bot
# writes data/deploy/request.json, and turns DEPLOY_FROM_CHAT on.
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/binjaibot}
APP_USER=${APP_USER:-ubuntu}
REPO=${REPO:-https://github.com/WilliamN40/binjai-kingdom-bot.git}
TARGET=${1:-origin/main}
git_as_app() { sudo -u "$APP_USER" git -C "$APP_DIR" "$@"; }

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Turning $APP_DIR into a git checkout of $REPO"
  git_as_app init -q
  git_as_app remote add origin "$REPO"
fi
git_as_app fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
git_as_app checkout -q -f --detach "$TARGET"
SHA=$(git_as_app rev-parse HEAD)

DEPLOY_DIR="$APP_DIR/data/deploy"
mkdir -p "$DEPLOY_DIR"
# The bot (uid of the data folder) writes requests and removes results here.
chown "$(stat -c %u:%g "$APP_DIR/data")" "$DEPLOY_DIR"
python3 -c 'import json,sys,datetime; open(sys.argv[1],"w").write(json.dumps({"sha":sys.argv[2],"deployedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}))' "$DEPLOY_DIR/current.json" "$SHA"

for unit in binjaibot-deploy.path binjaibot-deploy.service; do
  sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__APP_USER__#$APP_USER#g" "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now binjaibot-deploy.path

grep -q '^DEPLOY_FROM_CHAT=' "$APP_DIR/.env" || printf '\n# Owner can deploy from the chat (/deploy)\nDEPLOY_FROM_CHAT=true\n' >> "$APP_DIR/.env"

echo "Deployer installed. $APP_DIR is at $SHA. Rebuild and restart once to pick up DEPLOY_FROM_CHAT:"
echo "  cd $APP_DIR && docker compose up -d --build"
