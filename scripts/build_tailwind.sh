#!/usr/bin/env bash
# Build the docs/tailwind.css bundle from tailwind.config.js.
# Runs the standalone Tailwind binary so we don't need to commit a Node
# toolchain. The result is committed and served as a static file — the page
# no longer pulls the 350 KB Tailwind Play CDN script on cold start.
set -euo pipefail

cd "$(dirname "$0")/.."

TAILWIND_VERSION="${TAILWIND_VERSION:-v3.4.17}"
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS-$ARCH" in
  linux-x86_64)  asset="tailwindcss-linux-x64" ;;
  linux-aarch64) asset="tailwindcss-linux-arm64" ;;
  darwin-arm64)  asset="tailwindcss-macos-arm64" ;;
  darwin-x86_64) asset="tailwindcss-macos-x64" ;;
  *) echo "Unsupported platform: $OS/$ARCH" >&2; exit 1 ;;
esac

bin="${HOME}/.cache/film/tailwindcss-${TAILWIND_VERSION}"
if [ ! -x "$bin" ]; then
  mkdir -p "$(dirname "$bin")"
  curl -fsSL "https://github.com/tailwindlabs/tailwindcss/releases/download/${TAILWIND_VERSION}/${asset}" -o "$bin"
  chmod +x "$bin"
fi

mkdir -p docs
cat > /tmp/tailwind-input.css <<'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;
EOF

"$bin" build \
  -c tailwind.config.js \
  -i /tmp/tailwind-input.css \
  -o docs/tailwind.css \
  --minify

ls -lah docs/tailwind.css
