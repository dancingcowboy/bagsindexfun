# Bags Index — Solana dApp Store publishing

Workflow for shipping the Android build to the Solana Mobile dApp Store
(Saga / Seeker). Driven by the official `@solana-mobile/dapp-store-cli`.

## One-time prerequisites

1. **Mainnet keypair with funds** for minting publisher + app NFTs.
   Generate one and fund with ~0.2 SOL:

   ```bash
   solana-keygen new --outfile ~/.config/solana/bagsindex-publisher.json
   solana address -k ~/.config/solana/bagsindex-publisher.json   # fund this
   ```

2. **Release keystore** for signing the APK. Generate once and store
   somewhere outside the repo (it must NEVER be committed):

   ```bash
   keytool -genkeypair -v \
     -keystore ~/keys/bagsindex-release.keystore \
     -alias bagsindex \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   Then add to `~/.gradle/gradle.properties`:

   ```
   BAGS_RELEASE_STORE_FILE=/Users/markus/keys/bagsindex-release.keystore
   BAGS_RELEASE_STORE_PASSWORD=...
   BAGS_RELEASE_KEY_ALIAS=bagsindex
   BAGS_RELEASE_KEY_PASSWORD=...
   ```

3. **Store assets** dropped into `apps/mobile/dapp-store/assets/`:
   - `icon.png` — 512×512 PNG (square, no transparency)
   - `banner.png` — 1920×1080 PNG (feature graphic)
   - `screenshots/01..05-*.png` — at least 4, recommended 5–8;
     1080×1920 portrait or 1920×1080 landscape

4. **Edit `config.yaml`** — replace `REPLACE_WITH_PUBLISHER_PUBKEY` with
   your publisher pubkey from step 1. Bump `versionCode` /
   `versionName` in `apps/mobile/android/app/build.gradle` for every
   submission.

## Publish a release

End-to-end driver:

```bash
pnpm dapp-store:publish
```

Or step by step:

```bash
# 1. Build a signed release APK
pnpm dapp-store:build-apk

# 2. (one-time) Mint publisher NFT
pnpm dapp-store:create-publisher

# 3. (one-time per app) Mint app NFT
pnpm dapp-store:create-app

# 4. Mint a release NFT for this APK
pnpm dapp-store:create-release

# 5. Submit to Solana Mobile review
pnpm dapp-store:submit
```

Each step prints the on-chain NFT addresses — copy `release.address`
back into `config.yaml` after step 4 so subsequent updates can chain.

## Review SLA

Solana Mobile reviews dApp Store submissions in ~1–3 business days.
Status visible at https://publisher.dappstore.solanamobile.com/

## Updating an existing app

For a new version:
  - bump `versionCode` (must be strictly greater than last published)
  - update `release.catalog.en-US.new_in_version`
  - run `pnpm dapp-store:publish` again — it skips publisher/app
    creation and only mints a fresh release NFT, then submits.

## Notes

- The dApp Store does NOT require Google Play. The APK is the only
  distribution artifact. Sideload-friendly.
- Pairip / Play Integrity is NOT enforced — wallets like Phantom that
  exit on emulators because of Pairip will run fine on real Saga /
  Seeker hardware regardless.
- Mobile Wallet Adapter intent: the app already uses
  `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `transact()` —
  on Seeker this routes to Seed Vault automatically.
