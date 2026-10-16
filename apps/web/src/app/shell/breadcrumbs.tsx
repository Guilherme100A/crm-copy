// Breadcrumbs derivados do caminho (spec 18 §2.8) e título da aba `<página> · APP_NAME`.
import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { useEffect } from 'react'
import { useI18n, useT } from '@/i18n'
import { translate } from '@/i18n/core'
import { APP_NAME } from '@/lib/utils'

export interface Crumb {
  label: string
  to: string | null
}

const titleCase = (seg: string) => seg.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/** Ignora `welcome` e segmentos de id (números, uuids); traduz por `breadcrumbs.segments.<seg>` com fallback. */
export function crumbsFor(pathname: string, label: (seg: string) => string | null): Crumb[] {
  const segs = pathname.split('/').filter(Boolean)
  const out: Crumb[] = []
  let acc = ''
  for (const seg of segs) {
    acc += `/${seg}`
    if (seg === 'welcome' || /^\d+$/.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg)) continue
    out.push({ label: label(seg) ?? titleCase(seg), to: acc })
  }
  if (out.length) out[out.length - 1] = { ...out[out.length - 1]!, to: null }
  return out
}

export function Breadcrumbs() {
  const t = useT()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const crumbs = crumbsFor(pathname, (seg) => {
    const key = `breadcrumbs.segments.${seg}`
    const v = t(key)
    return v === key ? null : v
  })
  if (crumbs.length === 0) return null
  return (
    <nav data-testid="shell-breadcrumbs" aria-label={t('breadcrumbs.label')} className="mb-4 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {typeof window !== 'undefined' && window.history.length > 1 ? (
        <button type="button" onClick={() => router.history.back()} aria-label={t('breadcrumbs.back')} className="rounded p-1 hover:bg-accent">
          <ChevronLeft className="size-4" />
        </button>
      ) : null}
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        <li>
          <Link to={'/' as never} className="hover:text-foreground">
            {t('breadcrumbs.home')}
          </Link>
        </li>
        {crumbs.map((c) => (
          <li key={c.label + (c.to ?? '')} className="flex min-w-0 items-center gap-1">
            <span aria-hidden>/</span>
            {c.to ? (
              <Link to={c.to as never} className="truncate hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-foreground">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** `document.title` = `<último segmento traduzido> · APP_NAME` (só APP_NAME na home). */
export function usePageTitle(): void {
  const { locale } = useI18n()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    const crumbs = crumbsFor(pathname, (seg) => {
      const key = `breadcrumbs.segments.${seg}`
      const v = translate(locale, key)
      return v === key ? null : v
    })
    const page = crumbs.at(-1)?.label ?? (pathname === '/welcome' ? translate(locale, 'pages.welcome') : null)
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME
  }, [pathname, locale])
}
