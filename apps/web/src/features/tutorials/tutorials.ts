// Tutoriais (SPEC T108; 18 §9.1): link externo no fim de GESTÃO, com a URL de `TUTORIALS_URL` (via `GET /api/app-config`).
// Sem URL o item some; o usuário `support` nunca vê. Os outros papéis sempre veem, mesmo sem nenhum outro item de GESTÃO.
import { useQuery } from '@tanstack/react-query'
import { TUTORIALS_URL, type NavSection } from '@/app/nav'
import { appConfigQuery, type AppConfigDto } from '@/features/affiliate/api'

export const TUTORIALS_ITEM_ID = 'tutorials'
export const TUTORIALS_LINK_REL = 'noopener noreferrer'

/** URL http/https absoluta ou null. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Config carregada manda (null = sem tutoriais); antes de carregar, só a URL de build (`VITE_TUTORIALS_URL`), se houver. */
export function tutorialsUrlOf(config: Partial<AppConfigDto> | undefined, buildTime: string = TUTORIALS_URL): string | null {
  return config ? safeExternalUrl(config.tutorials_url) : safeExternalUrl(buildTime)
}

/** Ajusta as seções visíveis: item "Tutoriais" com a URL no fim de GESTÃO, ou nenhum item (sem URL / `support`). */
export function withTutorials(sections: NavSection[], all: NavSection[], url: string | null, isSupport: boolean): NavSection[] {
  const stripped = sections.map((s) => ({ ...s, items: s.items.filter((i) => i.id !== TUTORIALS_ITEM_ID) }))
  if (!url || isSupport) return stripped.filter((s) => s.items.length > 0)
  const template = all.flatMap((s) => s.items).find((i) => i.id === TUTORIALS_ITEM_ID)
  if (!template) return stripped
  const item = { ...template, href: url }
  const management = stripped.find((s) => s.id === 'management')
  if (management) return stripped.map((s) => (s === management ? { ...s, items: [...s.items, item] } : s))
  const base = all.find((s) => s.id === 'management')
  return base ? [...stripped, { ...base, items: [item] }] : stripped
}

/** URL dos tutoriais em runtime (sem URL → null). */
export function useTutorialsUrl(): string | null {
  const q = useQuery(appConfigQuery())
  return tutorialsUrlOf(q.data)
}
