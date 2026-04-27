import React from 'react'
import Svg, { Path, Circle } from 'react-native-svg'

export type TabIconName = 'market' | 'portfolio' | 'about' | 'settings'

interface Props {
  name: TabIconName
  color: string
  size?: number
}

const stroke = (color: string) => ({
  stroke: color,
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none' as const,
})

export function TabBarIcon({ name, color, size = 24 }: Props) {
  const s = stroke(color)
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'market' && (
        <>
          <Path d="M3 3v18h18" {...s} />
          <Path d="M18 17V9" {...s} />
          <Path d="M13 17V5" {...s} />
          <Path d="M8 17v-3" {...s} />
        </>
      )}
      {name === 'portfolio' && (
        <>
          <Path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" {...s} />
          <Path d="M3 5v14a2 2 0 0 0 2 2h16v-5" {...s} />
          <Path d="M18 12a2 2 0 0 0 0 4h4v-4Z" {...s} />
        </>
      )}
      {name === 'about' && (
        <>
          <Circle cx="12" cy="12" r="10" {...s} />
          <Path d="M12 16v-4" {...s} />
          <Path d="M12 8h.01" {...s} />
        </>
      )}
      {name === 'settings' && (
        <>
          <Path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            {...s}
          />
          <Circle cx="12" cy="12" r="3" {...s} />
        </>
      )}
    </Svg>
  )
}
