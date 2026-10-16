// Media query reativa: o shell renderiza OU a sidebar desktop OU o header/barra mobile (nunca os dois no DOM).
import { useSyncExternalStore } from 'react'

/** Breakpoint `lg` do Tailwind (spec 18 §2.4: sidebar desktop a partir de lg). */
export const DESKTOP_QUERY = '(min-width: 1024px)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => true,
  )
}

export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY)
