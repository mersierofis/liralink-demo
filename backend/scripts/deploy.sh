#!/usr/bin/env bash
# Deploys master to the live service (liralink-api.service on the EC2 host). Run after every merge
# to master — see "Deploying" in backend/README.md.
set -euo pipefail

cd "$(dirname "$0")/.."

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != master ]; then
  echo "deploy: checkout is on '$branch', not master — refusing" >&2
  exit 1
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm use 22.23.2 >/dev/null

git pull --ff-only
npm ci
npx prisma migrate deploy
# Prisma 7: migrate does not regenerate the client, and the build type-checks against it.
npx prisma generate
npm run build
sudo systemctl restart liralink-api

for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/health; then
    echo
    echo "deploy: $(git log --oneline -1) is live"
    exit 0
  fi
  sleep 2
done
echo "deploy: /api/health did not answer within 60 s — journalctl -u liralink-api" >&2
exit 1
