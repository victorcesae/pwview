#!/usr/bin/env sh
# Install pwview on Linux/macOS:
#   curl -fsSL https://raw.githubusercontent.com/<org>/pwview/main/install.sh | sh
# Env: PWVIEW_REPO (default below), PWVIEW_VERSION (default latest), PWVIEW_DIR (default ~/.local/bin)
set -eu

REPO="${PWVIEW_REPO:-victorcesae/pwview}"
VERSION="${PWVIEW_VERSION:-latest}"
DIR="${PWVIEW_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)          ASSET=pwview-linux-x86_64 ;;
  Linux-aarch64|Linux-arm64) ASSET=pwview-linux-aarch64 ;;
  Darwin-arm64)          ASSET=pwview-macos-aarch64 ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m). Use: cargo install --git https://github.com/$REPO" >&2; exit 1 ;;
esac

# The repo also publishes Steerhouse releases (steerhouse-v*), so GitHub's "latest" release may not
# be a pwview one. Ask for the newest vX.Y.Z tag instead (the API lists newest first).
if [ "$VERSION" = latest ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1) || true
  if [ -z "$VERSION" ]; then
    echo "No pwview release found in $REPO. Use: cargo install --git https://github.com/$REPO" >&2
    exit 1
  fi
fi
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

mkdir -p "$DIR"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$DIR/pwview.tmp"
chmod +x "$DIR/pwview.tmp"
mv "$DIR/pwview.tmp" "$DIR/pwview"
echo "Installed $DIR/pwview"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add $DIR to your PATH, e.g.: echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.bashrc" ;;
esac
