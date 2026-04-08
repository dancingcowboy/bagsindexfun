'use client'

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Bag shape */}
      <rect x="6" y="16" width="28" height="20" rx="4" fill="#00D62B" />
      {/* Bag handles */}
      <path
        d="M14 16V12C14 8.68629 16.6863 6 20 6V6C23.3137 6 26 8.68629 26 12V16"
        stroke="#00D62B"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Chart bars inside bag */}
      <rect x="12" y="26" width="3" height="6" rx="1" fill="#0c0c0c" opacity="0.6" />
      <rect x="17" y="23" width="3" height="9" rx="1" fill="#0c0c0c" opacity="0.6" />
      <rect x="22" y="20" width="3" height="12" rx="1" fill="#0c0c0c" opacity="0.6" />
      <rect x="27" y="24" width="3" height="8" rx="1" fill="#0c0c0c" opacity="0.6" />
    </svg>
  )
}

export function LogoFull({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className ?? ''}`}>
      <Logo size={32} />
      <div className="flex items-baseline gap-1">
        <span
          className="text-xl font-bold tracking-tight"
          style={{ color: '#00D62B' }}
        >
          bags
        </span>
        <span className="text-xl font-bold tracking-tight text-[var(--color-text-primary)]">
          index
        </span>
      </div>
    </div>
  )
}
