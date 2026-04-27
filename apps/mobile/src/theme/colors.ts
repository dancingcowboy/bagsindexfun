export const colors = {
  bg: '#0a0a0a',
  bgCard: '#141414',
  bgCardHover: '#1a1a1a',
  border: '#222222',
  borderLight: '#333333',

  green: '#00D62B',
  greenDim: 'rgba(0, 214, 43, 0.15)',
  red: '#FF4444',
  redDim: 'rgba(255, 68, 68, 0.15)',

  textPrimary: '#e8e8e8',
  textSecondary: '#999999',
  textMuted: '#666666',

  // Tier accents — chosen to be neutral identity colors that don't
  // trigger gain/loss perception. Avoid plain red (looks like losses)
  // and avoid the brand green (#00D62B) which is reserved for positive
  // PnL signals across the app.
  tierConservative: '#38BDF8', // sky blue
  tierBalanced: '#14B8A6',     // teal — distinct from brand green
  tierDegen: '#EC4899',        // hot pink

  white: '#ffffff',
  black: '#000000',
} as const

export type ColorName = keyof typeof colors
