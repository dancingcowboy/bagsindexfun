import type { RiskTier } from '@bags-index/shared'

export type SafetyVerdict = 'PASS' | 'REMOVED'

export interface ReviewInput {
  tokenMint: string
  symbol: string
  name: string
  holderCount: number
  liquidityUsd: number
  ageDays: number
  tier: RiskTier
}

export interface ReviewResult {
  verdict: SafetyVerdict
  reason: string
}

const SYSTEM_PROMPT = `You are the Bags Index Safety Reviewer — Layer A of a two-layer scoring system.

CONTEXT YOU MUST KNOW:
- All tokens come from Bags.fm. Bags is rug-proof by protocol: LP is structurally locked, mint authority is renounced, and there is no "dev sells the LP" path. You do NOT need to check LP locks, mint authority, or burn status — those are guaranteed.
- Brand impersonation / name similarity is NOT a reason to remove. Memes copy each other constantly; that's the genre. Do not flag a token just because it shares a name with PEPE, WIF, BONK, COIN, YZY, GOLEM, etc.
- The quant engine has already filtered for liquidity, holders, and age. Trust those numbers.

Your ONLY job is to flag tokens with ACTIVE catastrophic signals. Default to PASS.

Flag as REMOVED ONLY if you see:
- A documented active exploit, hack, or compromise of THIS specific token
- Confirmed wallet drainer / phishing contract masquerading as a token
- Holder count is exactly 1 (single-wallet token, not yet distributed)

Everything else is PASS. Low liquidity, low holders, young age, name similarity, generic meme — all PASS. The quant ranks them; your job is to catch real catastrophes only.

Respond with ONLY valid JSON. No markdown fences, no prose, no preamble. Exactly one of:
{"verdict":"PASS","reason":"short note"}
{"verdict":"REMOVED","reason":"specific catastrophic signal"}

Keep reason under 120 characters.`

async function callClaude(userPrompt: string): Promise<string> {
  const baseUrl = process.env.CLAUDE_API_BASE_URL || 'http://localhost:3456'
  const apiKey = process.env.CLAUDE_API_KEY || 'no-key-needed'
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Claude error: ${res.status}`)
  const data = (await res.json()) as any
  return data.choices[0].message.content as string
}

/**
 * Layer-A safety review. Fails OPEN — if the LLM is unreachable or returns
 * garbage, we default to PASS rather than silently removing every token.
 * The rationale is logged so the fail-open state is auditable.
 */
export async function reviewToken(input: ReviewInput): Promise<ReviewResult> {
  const userPrompt = `Review this token for the ${input.tier} tier:

Symbol: ${input.symbol}
Name: ${input.name}
Mint: ${input.tokenMint}
Holders: ${input.holderCount}
Liquidity: $${input.liquidityUsd.toLocaleString()}
Age: ${input.ageDays} days`

  try {
    const raw = await callClaude(userPrompt)
    const parsed = extractVerdict(raw)
    if (parsed) {
      return { verdict: parsed.verdict, reason: (parsed.reason ?? '').slice(0, 160) }
    }
    // Fallback: model returned prose. Treat as PASS — anything Bags-launched
    // is rug-proof, so failing open is the safe default.
    return { verdict: 'PASS', reason: 'agent returned prose; failing open (Bags rug-proof)' }
  } catch (err) {
    return {
      verdict: 'PASS',
      reason: `review unavailable, failing open (${(err as Error).message.slice(0, 80)})`,
    }
  }
}

/**
 * Best-effort JSON extraction. The model occasionally wraps the JSON in
 * markdown, prepends prose, or refuses outright. We try several strategies
 * before giving up and failing open.
 */
function extractVerdict(raw: string): ReviewResult | null {
  if (!raw) return null
  const candidates: string[] = []
  // 1. Markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) candidates.push(fenceMatch[1])
  // 2. First {...} block (greedy on the inner braces)
  const braceMatch = raw.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/)
  if (braceMatch) candidates.push(braceMatch[0])
  // 3. Whole string trimmed
  candidates.push(raw.trim())

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      if (obj?.verdict === 'PASS' || obj?.verdict === 'REMOVED') {
        return { verdict: obj.verdict, reason: obj.reason ?? '' }
      }
    } catch {
      /* try next candidate */
    }
  }

  // 4. Last-resort substring sniff: if the prose says "PASS" but no JSON, trust it
  const upper = raw.toUpperCase()
  if (upper.includes('"VERDICT":"PASS"') || /\bPASS\b/.test(upper) && !/\bREMOVE/.test(upper)) {
    return { verdict: 'PASS', reason: 'inferred from prose response' }
  }
  return null
}
