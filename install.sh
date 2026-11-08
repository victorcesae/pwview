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
  Darwin-x86_64)         ASSET=pwview-macos-x86_64 ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m). Use: cargo install --git https://github.com/$REPO" >&2; exit 1 ;;
esac

if [ "$VERSION" = latest ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

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
