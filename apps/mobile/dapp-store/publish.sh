#!/usr/bin/env bash
set -euo pipefail

# Solana Mobile dApp Store publish driver.
#
# As of CLI 0.16+, NFT minting (publisher / app) is performed via the
# publisher portal web UI at https://publish.solanamobile.com — not via
# this CLI. The CLI only submits release APKs to the portal.
#
# Prerequisites (one-time):
#   1. Visit https://publish.solanamobile.com, sign in with your
#      publisher keypair, create publisher + app entries.
#   2. Generate an API key in the portal and export it:
#        export DAPP_STORE_API_KEY=<key>
#   3. Build a signed release APK (./gradlew assembleRelease).

PUBLISHER_KEYPAIR="${PUBLISHER_KEYPAIR:-$HOME/.config/solana/bagsindex-publisher.json}"
DAPP_PORTAL="${DAPP_STORE_PORTAL_URL:-https://publish.solanamobile.com}"

# Auto-load API key from disk if env var not set
if [[ -z "${DAPP_STORE_API_KEY:-}" && -f "$HOME/.config/solana/dapp-store-api-key" ]]; then
  export DAPP_STORE_API_KEY="$(cat "$HOME/.config/solana/dapp-store-api-key")"
fi

DAPP_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(cd "$DAPP_DIR/../android" && pwd)"
APK_OUT="$DAPP_DIR/build/app-release.apk"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[dapp-store]${NC} $1"; }
warn() { echo -e "${YELLOW}[dapp-store]${NC} $1"; }
err()  { echo -e "${RED}[dapp-store]${NC} $1"; exit 1; }

DAPP_CLI=(pnpm dlx @solana-mobile/dapp-store-cli)

require_keypair() {
  [[ -f "$PUBLISHER_KEYPAIR" ]] || err "Publisher keypair not found at $PUBLISHER_KEYPAIR"
}

require_apikey() {
  [[ -n "${DAPP_STORE_API_KEY:-}" ]] || err "DAPP_STORE_API_KEY not set — generate one in the publisher portal"
}

case "${1:-help}" in
  build-apk)
    log "Building signed release APK..."
    cd "$ANDROID_DIR"
    ./gradlew assembleRelease
    APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
    [[ -f "$APK_PATH" ]] || err "Release APK not found at $APK_PATH"
    mkdir -p "$DAPP_DIR/build"
    cp "$APK_PATH" "$APK_OUT"
    log "APK ready at $APK_OUT ($(du -h "$APK_OUT" | cut -f1))"
    ;;

  submit)
    require_keypair
    require_apikey
    [[ -f "$APK_OUT" ]] || err "No APK at $APK_OUT — run build-apk first"
    WHATS_NEW="${WHATS_NEW:-Initial release.}"
    log "Submitting $APK_OUT to $DAPP_PORTAL ..."
    "${DAPP_CLI[@]}" \
      --apk-file "$APK_OUT" \
      --whats-new "$WHATS_NEW" \
      --portal-url "$DAPP_PORTAL" \
      --keypair "$PUBLISHER_KEYPAIR" \
      --verbose
    log "Submission complete. Track status in the portal: $DAPP_PORTAL"
    ;;

  publish)
    log "Build APK + submit to portal"
    "$0" build-apk
    "$0" submit
    ;;

  resume)
    require_keypair
    require_apikey
    shift
    "${DAPP_CLI[@]}" resume \
      --portal-url "$DAPP_PORTAL" \
      --keypair "$PUBLISHER_KEYPAIR" \
      "$@"
    ;;

  help|*)
    cat <<USAGE
Usage: $0 <command>

Commands:
  build-apk   Build & sign the release APK
  submit      Submit current APK to the publisher portal
  publish     Build + submit (one-shot)
  resume      Resume a partially completed publication session
              (pass --release-id and optionally --session-id)

Env vars:
  PUBLISHER_KEYPAIR     Path to publisher keypair JSON
                        (default: ~/.config/solana/bagsindex-publisher.json)
  DAPP_STORE_API_KEY    Portal API key (required for submit/resume)
  DAPP_STORE_PORTAL_URL Portal origin
                        (default: https://publish.solanamobile.com)
  WHATS_NEW             Release notes for this version
                        (default: "Initial release.")

One-time setup happens in the portal UI:
  1. Go to https://publish.solanamobile.com
  2. Sign in with publisher keypair (pubkey: see solana-keygen pubkey output)
  3. Create publisher + app entries (portal mints the NFTs for you)
  4. Generate an API key, export as DAPP_STORE_API_KEY
USAGE
    ;;
esac
