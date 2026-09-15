#!/usr/bin/env bash
# Build Marmot.app, embed the Node engine, ad-hoc sign, and produce a zip, a
# DMG and a filled-in Homebrew cask under macos/dist.
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(dirname "$MACOS_DIR")"
VERSION="${VERSION:-0.2.0}"
# The Node that ships inside the app. `NODE_ARCHS=arm64` halves the download
# if Intel Macs do not matter.
NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_ARCHS="${NODE_ARCHS:-arm64 x64}"
BUNDLE_ID="io.drdroid.marmot"
DIST="$MACOS_DIR/dist"
APP="$DIST/Marmot.app"

echo "==> Building Marmot $VERSION"
# `--arch arm64 --arch x86_64` needs Xcode's build system. Building each
# triple and merging with lipo works with the Command Line Tools alone.
BIN=""
if [[ "${UNIVERSAL:-1}" == "1" ]] \
  && swift build -c release --package-path "$MACOS_DIR" --triple arm64-apple-macosx14.0 \
  && swift build -c release --package-path "$MACOS_DIR" --triple x86_64-apple-macosx14.0; then
  BIN="$MACOS_DIR/.build/Marmot-universal"
  lipo -create -output "$BIN" \
    "$MACOS_DIR/.build/arm64-apple-macosx/release/Marmot" \
    "$MACOS_DIR/.build/x86_64-apple-macosx/release/Marmot"
  echo "    universal ($(lipo -archs "$BIN"))"
fi
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  swift build -c release --package-path "$MACOS_DIR"
  BIN="$(swift build -c release --package-path "$MACOS_DIR" --show-bin-path)/Marmot"
  echo "    host architecture ($(uname -m))"
fi

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine/docs"
cp "$BIN" "$APP/Contents/MacOS/Marmot"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Marmot</string>
  <key>CFBundleDisplayName</key><string>Marmot</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Marmot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>© DrDroid</string>
</dict>
</plist>
PLIST

echo "==> Icons"
ICON_SRC="$REPO/docs/marmot.png"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
cp "$ICON_SRC" "$APP/Contents/Resources/marmot.png"
sips -z 36 36 "$ICON_SRC" --out "$APP/Contents/Resources/marmot-menubar.png" >/dev/null

echo "==> Embedding the engine"
ENGINE="$APP/Contents/Resources/engine"
for item in bin src scripts commands hooks .claude-plugin package.json README.md LICENSE; do
  cp -R "$REPO/$item" "$ENGINE/"
done
for f in marmot.svg marmot.ico marmot.png; do
  cp "$REPO/docs/$f" "$ENGINE/docs/"
done
chmod +x "$ENGINE/bin/marmot.mjs"

echo "==> Embedding Node $NODE_VERSION"
# A clean Mac has no Node. Ship the official binary inside the app, so the
# DMG and the brew cask both work with nothing else installed. Only `node`
# itself: the engine has zero dependencies, so npm is not needed.
NODE_CACHE="$MACOS_DIR/.build/node-cache/$NODE_VERSION"
mkdir -p "$NODE_CACHE"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$NODE_CACHE/SHASUMS256.txt"
NODE_BINS=()
for arch in $NODE_ARCHS; do
  tarball="node-$NODE_VERSION-darwin-$arch.tar.gz"
  if [[ ! -f "$NODE_CACHE/$arch/node" ]]; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$NODE_CACHE/$tarball"
    (cd "$NODE_CACHE" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
      || { echo "checksum mismatch for $tarball" >&2; exit 1; }
    mkdir -p "$NODE_CACHE/$arch"
    tar -xzf "$NODE_CACHE/$tarball" -C "$NODE_CACHE/$arch" --strip-components 2 "node-$NODE_VERSION-darwin-$arch/bin/node"
    rm -f "$NODE_CACHE/$tarball"
  fi
  NODE_BINS+=("$NODE_CACHE/$arch/node")
done
mkdir -p "$APP/Contents/Resources/node/bin"
if [[ ${#NODE_BINS[@]} -gt 1 ]]; then
  lipo -create -output "$APP/Contents/Resources/node/bin/node" "${NODE_BINS[@]}"
else
  cp "${NODE_BINS[0]}" "$APP/Contents/Resources/node/bin/node"
fi
chmod +x "$APP/Contents/Resources/node/bin/node"
echo "    $(lipo -archs "$APP/Contents/Resources/node/bin/node") · $(du -h "$APP/Contents/Resources/node/bin/node" | awk '{print $1}')"

# `marmot` on the command line, running the bundled Node — brew links this.
mkdir -p "$APP/Contents/Resources/bin"
cat > "$APP/Contents/Resources/bin/marmot" <<'WRAP'
#!/bin/sh
# Follow brew's symlink back into the app, then run the engine on the Node
# that ships inside it.
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
res="$(cd "$(dirname "$self")/.." && pwd)"
exec "$res/node/bin/node" "$res/engine/bin/marmot.mjs" "$@"
WRAP
chmod +x "$APP/Contents/Resources/bin/marmot"

echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> Zip and DMG"
ZIP="$DIST/Marmot-$VERSION.zip"
DMG="$DIST/Marmot-$VERSION.dmg"
rm -f "$ZIP" "$DMG"
(cd "$DIST" && ditto -c -k --sequesterRsrc --keepParent "Marmot.app" "$ZIP")
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Marmot -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
DMG_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
sed -e "s/__VERSION__/$VERSION/" -e "s/__SHA256__/$ZIP_SHA/" "$MACOS_DIR/Casks/marmot.rb" > "$DIST/marmot.rb"

echo
echo "Built:"
echo "  $APP"
echo "  $ZIP  sha256 $ZIP_SHA"
echo "  $DMG  sha256 $DMG_SHA"
echo "  $DIST/marmot.rb  (cask, sha filled in)"
