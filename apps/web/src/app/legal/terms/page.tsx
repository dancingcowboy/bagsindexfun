export const metadata = { title: 'Terms of Service · Bags Index' }

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p>Last updated: 2026-04-27</p>

      <h2>1. What Bags Index is</h2>
      <p>
        Bags Index (&quot;the Service&quot;) is a Solana application
        that automatically allocates user-deposited SOL across baskets
        of tokens launched on Bags.fm. Three risk tiers —
        Conservative, Balanced, and Degen — each rebalance on a fixed
        schedule using a √-weighted composite score.
      </p>

      <h2>2. Wallet model and custody</h2>
      <p>
        When you connect, the Service uses{' '}
        <a href="https://www.privy.io" target="_blank" rel="noreferrer">
          Privy
        </a>{' '}
        to create per-tier sub-wallets bound to your main wallet
        identity. Bags Index does <strong>not</strong> store sub-wallet
        private keys; the underlying key material is managed by Privy
        infrastructure under their security model. The agent signs
        rebalance and withdrawal transactions inside those sub-wallets
        on your behalf, scoped to the activity of the Service.
      </p>
      <p>
        Practically this means:
      </p>
      <ul>
        <li>
          Your <em>main</em> wallet remains under your sole control.
          Bags Index never holds, stores, or has signing authority over
          your main wallet.
        </li>
        <li>
          Your <em>sub-wallets</em> are created and operated through
          the Service. You cannot interact with them outside of the
          Bags Index app or through the Privy session bound to your
          identity. The Service is therefore custodial in operation
          even though Bags Index does not itself hold the keys.
        </li>
        <li>
          Withdrawal of the full sub-wallet balance back to your main
          wallet is always available from inside the app.
        </li>
        <li>
          Continuity of your access depends on the continued operation
          of the Service and of Privy. If either becomes unavailable,
          recovery of sub-wallet funds may be delayed or, in adverse
          scenarios, may require coordination with Privy under their
          terms.
        </li>
      </ul>

      <h2>3. Not financial advice</h2>
      <p>
        <strong>Nothing on Bags Index is financial, investment, legal,
        or tax advice.</strong> The composite scores, tier labels
        (Conservative / Balanced / Degen), AI-generated commentary,
        rebalance schedule, performance charts, time-weighted return
        (TWR) figures, and any other quantitative or qualitative
        outputs in the app or on this website are heuristic results of
        automated systems. They are NOT recommendations, predictions,
        or solicitations to buy, sell, or hold any token. You are
        solely responsible for evaluating whether to use the Service
        and for any consequences of doing so.
      </p>

      <h2>4. Past performance is not indicative of future results</h2>
      <p>
        <strong>Past performance is never indicative of future
        outcomes.</strong> The historical returns, index lines, tier
        backtests, and per-token performance figures shown in the app
        and on this website describe what happened previously under
        specific market conditions. They make no representation about
        future returns. Future returns may be materially worse,
        including total loss of deposited SOL.
      </p>

      <h2>5. Bags ecosystem volatility — user acknowledgment</h2>
      <p>
        By using the Service you acknowledge and accept that you are
        exposing your deposited SOL to the full volatility of the
        Bags.fm token ecosystem. You specifically acknowledge that:
      </p>
      <ul>
        <li>
          Any token in any tier may go to zero at any time, including
          immediately after a rebalance.
        </li>
        <li>
          Tokens may be subject to rug pulls, smart-contract exploits,
          insider selling, liquidity removal, social-media-driven
          collapses, regulatory action, or any other failure mode
          common to memecoins and microcap tokens.
        </li>
        <li>
          The agent rebalances based on a score that may rise or fall
          rapidly. The basket you are exposed to today is not
          guaranteed to be the basket you are exposed to tomorrow.
        </li>
        <li>
          Slippage, MEV, failed transactions, and on-chain delays may
          cause executed prices to diverge significantly from observed
          market prices.
        </li>
        <li>
          The &quot;Conservative&quot; tier is conservative
          <em> only relative to the other Bags Index tiers</em>. It is
          NOT conservative relative to traditional financial
          instruments and remains exposed to memecoin-grade risk.
        </li>
      </ul>
      <p>
        <strong>
          You assume all risk of using the Service. Do not deposit more
          SOL than you can afford to lose entirely.
        </strong>
      </p>

      <h2>6. Token risk surface</h2>
      <p>
        The Service routes trades into and out of Bags.fm tokens based
        on score. It does not insure against any price move, rug pull,
        contract exploit, liquidity disappearance, oracle failure, or
        any other token-level failure mode. Bags Index is not
        affiliated with any individual token creator and does not
        endorse any token included in any basket.
      </p>

      <h2>7. Eligibility</h2>
      <p>
        You must be of legal age in your jurisdiction to use the
        Service. You may not use the Service if you are a resident of,
        or located in, a jurisdiction where access to or use of
        decentralized financial services is prohibited.
      </p>

      <h2>8. Fees</h2>
      <p>
        The Service may charge a performance or management fee, claimed
        on-chain from your sub-wallet on a fixed schedule. Current fee
        terms are visible in the app and may change with notice.
        Network transaction fees (gas) are paid from your sub-wallet.
      </p>

      <h2>9. No warranties</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranty of
        any kind. We do not guarantee uptime, rebalance frequency,
        accuracy of data feeds, completeness of safety checks, or that
        any deposit will appreciate.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Bags Index, its
        operators, and contributors are not liable for any indirect,
        consequential, exemplary, or punitive damages, or any loss of
        profits, data, or token value, arising from your use of the
        Service.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update these Terms at any time. Material changes will be
        announced in-app. Continued use of the Service constitutes
        acceptance of the updated Terms.
      </p>

      <h2>12. Contact</h2>
      <p>
        <a href="mailto:support@bagsindex.fun">support@bagsindex.fun</a>
      </p>
    </>
  )
}
