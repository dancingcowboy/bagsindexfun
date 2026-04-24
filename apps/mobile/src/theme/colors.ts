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

  // Tier colors
  tierConservative: '#3B82F6',
  tierBalanced: '#F59E0B',
  tierDegen: '#EF4444',

  white: '#ffffff',
  black: '#000000',
} as const

export type ColorName = keyof typeof colors
