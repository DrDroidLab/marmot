# Marmot for macOS

A menu bar app for Marmot: Claude plan limits, cost, tokens, recommendations and
nudges, with a settings window. The app is a thin SwiftUI shell over Marmot's
Node engine, which ships inside the bundle — every number and every rule comes
from the same code as the CLI.

Requires macOS 14+. Node (v24 LTS) ships inside the app, so nothing else needs
installing.

## Build and run from source

The usual way: package it and open the result. Needs only Apple's Command Line
Tools (`xcode-select --install`).

```bash
macos/scripts/package.sh            # VERSION=0.2.0 by default
open macos/dist/Marmot.app          # or: cp -R macos/dist/Marmot.app /Applications
```

`package.sh` writes `dist/Marmot.app`, `dist/Marmot-<version>.zip`,
`dist/Marmot-<version>.dmg` and `dist/marmot.rb` (the cask, with the zip's
sha256 filled in). The first run downloads the official Node binary (checksum
verified) and caches it in `.build/node-cache`; later builds reuse it.

A quicker dev run skips the bundle. It has no Node of its own, so it needs Node
18+ on your `PATH` (or `MARMOT_NODE`), and notifications do not work outside an
`.app`:

```bash
cd macos
swift build -c release
MARMOT_ENGINE="$PWD/../bin/marmot.mjs" .build/release/Marmot
```

## Install with Homebrew

```bash
brew install --cask drdroidlab/tap/marmot
```

The cask installs `Marmot.app`, with Node inside it, and links the `marmot` CLI
from the bundle. It needs no `node` formula. The app is ad-hoc signed for now,
so the cask clears the quarantine flag; a DMG download needs System Settings →
Privacy & Security → Open Anyway once.

## Releasing

1. `VERSION=0.2.0 macos/scripts/package.sh`
2. `gh release create app-v0.2.0 macos/dist/Marmot-0.2.0.zip macos/dist/Marmot-0.2.0.dmg`
3. Copy `macos/dist/marmot.rb` to `DrDroidLab/homebrew-tap/Casks/marmot.rb` and push.
