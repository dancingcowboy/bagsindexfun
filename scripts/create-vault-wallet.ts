import 'dotenv/config'
import { createSolanaServerWallet } from '@bags-index/solana'

/**
 * One-time script to provision the Privy Server Wallet for the protocol vault.
 * Run with: pnpm tsx scripts/create-vault-wallet.ts
 *
 * Copy the output into .env:
 *   VAULT_WALLET_ADDRESS=<address>
 *   VAULT_PRIVY_WALLET_ID=<walletId>
 */
async function main() {
  console.log('[create-vault-wallet] Creating Solana server wallet via Privy...')
  const { walletId, address } = await createSolanaServerWallet()
  console.log('')
  console.log('  ✓ Vault wallet created')
  console.log('')
  console.log(`  VAULT_WALLET_ADDRESS=${address}`)
  console.log(`  VAULT_PRIVY_WALLET_ID=${walletId}`)
  console.log('')
  console.log('  Add the above to .env (local) and the production env on the production server.')
  console.log('  Then set the vault wallet as the 20% fee-share recipient when')
  console.log('  creating the $BAGSX token on the Bags app.')
}

main().catch((err) => {
  console.error('[create-vault-wallet] Failed:', err)
  process.exit(1)
})
