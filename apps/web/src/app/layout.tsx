import type { Metadata } from 'next'
import { DM_Sans, DM_Mono } from 'next/font/google'
import { PrivyAuthProvider } from '@/providers/privy'
import { QueryProvider } from '@/providers/query'
import './globals.css'

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Bags Index — The Index Fund for Bags',
  description:
    'Auto-rebalancing index vault for the Bags ecosystem on Solana. Per-user Privy sub-wallets, withdraw anytime. Top 10 tokens, daily rebalancing, buy-and-burn flywheel.',
  icons: {
    icon: '/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <body className={dmSans.className}>
        <PrivyAuthProvider>
          <QueryProvider>{children}</QueryProvider>
        </PrivyAuthProvider>
      </body>
    </html>
  )
}
