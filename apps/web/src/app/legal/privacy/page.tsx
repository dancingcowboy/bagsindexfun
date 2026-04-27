export const metadata = { title: 'Privacy Policy · Bags Index' }

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Last updated: 2026-04-27</p>

      <h2>What we collect</h2>
      <p>
        Bags Index is a Solana application built on user-bound Privy
        sub-wallets (see Terms §2 for the wallet model). To operate the
        service we collect only what is strictly required:
      </p>
      <ul>
        <li>
          <strong>Wallet public key.</strong> Your main Solana wallet
          address, captured when you connect via Mobile Wallet Adapter.
          Used to bind your Privy sub-wallets to your identity and to
          load your holdings.
        </li>
        <li>
          <strong>Sub-wallet public keys.</strong> Per-tier addresses
          created via Privy and bound to your main wallet identity.
          Stored in our database alongside your main wallet for routing
          deposits and withdrawals. We do not store the private keys
          for these sub-wallets — they are managed by Privy.
        </li>
        <li>
          <strong>On-chain transaction history</strong> for your
          sub-wallets, loaded from public RPC providers to display your
          performance.
        </li>
        <li>
          <strong>Standard request metadata</strong> (IP address, user
          agent, timestamps) retained briefly for abuse prevention and
          rate limiting.
        </li>
      </ul>

      <h2>What we do NOT collect</h2>
      <ul>
        <li>Private keys, seed phrases, or any signing material.</li>
        <li>Email address (unless you contact support voluntarily).</li>
        <li>Real name, phone number, or government identification.</li>
        <li>Cross-site tracking cookies or third-party advertising IDs.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Your wallet address and sub-wallet records are used solely to
        operate the index fund: route deposits, execute rebalances on
        the agent&apos;s behalf, calculate your share, and process
        withdrawals back to your main wallet. We do not sell or share
        this data with third parties for marketing.
      </p>

      <h2>Third parties we rely on</h2>
      <ul>
        <li>
          <strong>Privy</strong> for sub-wallet creation and key
          custody. Your main-wallet identity is shared with Privy to
          bind the sub-wallets to you. See{' '}
          <a href="https://www.privy.io/legal/privacy-policy" target="_blank" rel="noreferrer">
            Privy&apos;s privacy policy
          </a>{' '}
          for their handling of that data.
        </li>
        <li>
          <strong>Solana RPC providers</strong> (Helius and others) for
          on-chain reads and transaction submission.
        </li>
        <li>
          <strong>DexScreener</strong> for token price + liquidity data.
        </li>
        <li>
          <strong>Bags.fm</strong> for token universe + creator metadata.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can stop using the app at any time by withdrawing all
        deposited SOL. To request deletion of your sub-wallet records
        from our database after a full withdrawal, email
        support@bagsindex.fun from a wallet you control (signed message
        proof may be requested).
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:support@bagsindex.fun">support@bagsindex.fun</a>
      </p>
    </>
  )
}
