#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 server for Makelo.
# Run as root:  curl -fsSL https://raw.githubusercontent.com/wondersbuilders/makelo/main/deploy/setup-server.sh | bash
set -euo pipefail

REPO="${REPO:-https://github.com/wondersbuilders/makelo.git}"
DIR="${DIR:-/opt/makelo}"

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Firewall: SSH, HTTP, HTTPS"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
fi

echo "==> Swap (helps the builder image compile on 4 GB servers)"
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Getting the code into $DIR"
if [ ! -d "$DIR/.git" ]; then
  # Private repo? Use a deploy key or: REPO=https://<github-token>@github.com/wondersbuilders/makelo.git
  git clone "$REPO" "$DIR"
fi

cd "$DIR/deploy"
if [ ! -f .env ]; then
  cp .env.example .env
  # Generate the encryption key for stored API keys once — never change it afterwards.
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" .env
  sed -i "s|^SERVER_IPV4=.*|SERVER_IPV4=$(curl -fsS4 https://api.ipify.org || echo CHANGE_ME)|" .env
fi

cat <<MSG

Done. Next:
  1. nano $DIR/deploy/.env      # set SITES_DOMAIN, APP_HOST, ADMIN_HOST, ADMIN_EMAILS, ACME_EMAIL, CLOUDFLARE_API_TOKEN
  2. cd $DIR/deploy && docker compose up -d --build
  3. Open https://<ADMIN_HOST>, sign up with an ADMIN_EMAILS address, then add your keys in Admin → API keys.
MSG
