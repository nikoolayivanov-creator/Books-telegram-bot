#!/usr/bin/env bash
set -euo pipefail
VPS=user@your-server-ip
KEY=${VPS_KEY:-$HOME/.ssh/id_ed25519}
REMOTE=/opt/flibusta-bot

echo "Sync to $VPS:$REMOTE (tar over ssh — rsync недоступен на Windows/Git Bash)"
tar czf - \
  --exclude=node_modules --exclude=dist --exclude=data \
  --exclude=.env --exclude=.git \
  . | ssh -i "$KEY" "$VPS" "mkdir -p '$REMOTE' && cd '$REMOTE' && tar xzf -"

echo "Build & restart"
ssh -i "$KEY" "$VPS" "cd $REMOTE && docker compose build && docker compose up -d && docker compose logs --tail=20 flibusta-bot"
