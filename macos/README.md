# Marmot for macOS

A menu bar app for Marmot: Claude plan limits, cost, tokens, recommendations and
nudges, with a settings window. The app is a thin SwiftUI shell over Marmot's
Node engine, which ships inside the bundle — every number and every rule comes
from the same code as the CLI.

Requires macOS 14+ and Node.js 18+ on the machine.

## Build and run from source

```bash
cd macos
swift build -c release
MARMOT_ENGINE="$PWD/../bin/marmot.mjs" .build/release/Marmot   # dev run, no notifications
```

Notifications need a real `.app` bundle, so package it to try them:

```bash
macos/scripts/package.sh            # VERSION=0.2.0 by default
open macos/dist/Marmot.app          # or: cp -R macos/dist/Marmot.app /Applications
```

`package.sh` writes `dist/Marmot.app`, `dist/Marmot-<version>.zip`,
`dist/Marmot-<version>.dmg` and `dist/marmot.rb` (the cask, with the zip's
sha256 filled in).

## Install with Homebrew

```bash
brew install --cask drdroidlab/tap/marmot
```

The cask installs `Marmot.app`, links the `marmot` CLI from the bundle, and
depends on the `node` formula. The app is ad-hoc signed for now, so the cask
clears the quarantine flag; a DMG download needs System Settings → Privacy &
Security → Open Anyway once.

## Releasing

1. `VERSION=0.2.0 macos/scripts/package.sh`
2. `gh release create app-v0.2.0 macos/dist/Marmot-0.2.0.zip macos/dist/Marmot-0.2.0.dmg`
3. Copy `macos/dist/marmot.rb` to `DrDroidLab/homebrew-tap/Casks/marmot.rb` and push.
