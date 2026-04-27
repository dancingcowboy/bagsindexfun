export const metadata = { title: 'Terms of Service · Bags Index' }

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p>Last updated: 2026-04-27</p>

      <h2>1. What Bags Index is</h2>
      <p>
        Bags Index (&quot;the Service&quot;) is a non-custodial Solana
        application that automatically allocates user-deposited SOL
        across baskets of tokens launched on Bags.fm. Three risk tiers
        — Conservative, Balanced, and Degen — each rebalance on a fixed
        schedule using a √-weighted composite score.
      </p>

      <h2>2. Non-custodial nature</h2>
      <p>
        When you deposit SOL, the Service generates a sub-wallet for
        you. The agent acts within that sub-wallet on your behalf to
        execute rebalances. You may withdraw the full sub-wallet
        balance back to your main wallet at any time. Bags Index does
        NOT take custody of your main wallet&apos;s funds and cannot
        sign transactions outside of authorized sub-wallet activity.
      </p>

      <h2>3. No investment advice</h2>
      <p>
        Nothing on Bags Index is financial, investment, legal, or tax
        advice. The composite scores, AI-generated commentary, and
        risk-tier labels are heuristic outputs of automated systems and
        should not be treated as recommendations. You are solely
        responsible for assessing whether to use the Service.
      </p>

      <h2>4. Token risk</h2>
      <p>
        Tokens listed on Bags.fm are highly volatile and may go to
        zero. Memecoin and microcap exposure carries extreme risk of
        total loss. The Service routes trades into and out of these
        tokens based on score; it does not insure against price moves,
        rug pulls, contract exploits, liquidity disappearance, or any
        other token-level failure mode.
      </p>

      <h2>5. Eligibility</h2>
      <p>
        You must be of legal age in your jurisdiction to use the
        Service. You may not use the Service if you are a resident of,
        or located in, a jurisdiction where access to or use of
        decentralized financial services is prohibited.
      </p>

      <h2>6. Fees</h2>
      <p>
        The Service may charge a performance or management fee, claimed
        on-chain from your sub-wallet on a fixed schedule. Current fee
        terms are visible in the app and may change with notice.
        Network transaction fees (gas) are paid from your sub-wallet.
      </p>

      <h2>7. No warranties</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranty of
        any kind. We do not guarantee uptime, rebalance frequency,
        accuracy of data feeds, or that any deposit will appreciate.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Bags Index, its
        operators, and contributors are not liable for any indirect,
        consequential, exemplary, or punitive damages, or any loss of
        profits, data, or token value, arising from your use of the
        Service.
      </p>

      <h2>9. Changes</h2>
      <p>
        We may update these Terms at any time. Material changes will be
        announced in-app. Continued use of the Service constitutes
        acceptance of the updated Terms.
      </p>

      <h2>10. Contact</h2>
      <p>
        <a href="mailto:support@bagsindex.fun">support@bagsindex.fun</a>
      </p>
    </>
  )
}
