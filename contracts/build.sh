#!/usr/bin/env bash
# StellarSwap Contract Build Script
# Compiles all 5 Soroban contracts to WASM for deployment to Stellar testnet.
#
# Usage: ./contracts/build.sh
# Output: contracts/target/wasm32-unknown-unknown/release/*.wasm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUSTUP_TOOLCHAIN="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu"
CARGO="$RUSTUP_TOOLCHAIN/bin/cargo"

# Fix: LD_PRELOAD librustc_driver to avoid "cannot allocate memory in static TLS block"
# This is needed in NixOS/container environments where glibc TLS space is limited.
LIBDRV=$(ls "$RUSTUP_TOOLCHAIN/lib/librustc_driver"*.so 2>/dev/null | head -1 || true)
if [ -n "$LIBDRV" ]; then
  export LD_PRELOAD="$LIBDRV"
  echo "Using LD_PRELOAD: $LIBDRV"
fi

if [ ! -x "$CARGO" ]; then
  echo "ERROR: rustup cargo not found at $CARGO"
  echo "Run: rustup default stable && rustup target add wasm32-unknown-unknown"
  exit 1
fi

echo "Building Soroban contracts for wasm32-unknown-unknown..."
echo "Using: $CARGO"

"$CARGO" build \
  --manifest-path "$SCRIPT_DIR/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release \
  --locked 2>&1

echo ""
echo "Build complete. WASM files:"
ls -lh "$SCRIPT_DIR/target/wasm32-unknown-unknown/release/"*.wasm 2>/dev/null || echo "(no files yet)"
