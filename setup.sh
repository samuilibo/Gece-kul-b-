#!/usr/bin/env bash
# NEON CLUB LIVE - setup for Linux/macOS (development). Windows users: setup.bat
set -e
cd "$(dirname "$0")"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)){console.error("Node 22.13+ required");process.exit(1)}'
npm ci || npm install
[ -f .env ] || cp .env.example .env
mkdir -p music
npm run build
echo "Done. Start with: npm start   (admin: http://localhost:3000/admin, live: http://localhost:3000/live)"
