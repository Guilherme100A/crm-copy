// Layout do módulo Facebook (11 §2): cabeçalho (ícone, título, subtítulo), abas das sub-rotas permitidas e um slot de
// toolbar que a sub-página preenche. O contêiner mantém `page-facebook` (id do placeholder da T23).
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Megaphone } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '@/i18n'
import { profileQuery, sessionFrom } from '@/lib/session'
import { cn } from '@/lib/utils'
import { allowedSubs, type FacebookSub } from './rules'

export const NS = 'facebook'

/** Sessão atual (perfil em cache do shell). */
export function useFacebookSession() {
  const profile = useQuery(profileQuery()).data
  return profile ? sessionFrom(profile) : null
}

export function FacebookLayout({ active, toolbar, children }: { active: FacebookSub; toolbar?: ReactNode; children: ReactNode }) {
  const t = useT(NS)
  const session = useFacebookSession()
  const subs = allowedSubs(session)
  return (
    <section data-testid="page-facebook" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Megaphone className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        {toolbar ? (
          <div data-testid="facebook-toolbar" className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
            {toolbar}
          </div>
        ) : null}
      </header>
      <nav aria-label={t('tabs.label')} className="flex gap-1 overflow-x-auto border-b">
        {subs.map((s) => (
          <Link
            key={s}
            to={`/facebook/${s}` as never}
            data-testid={`facebook-tab-${s}`}
            aria-current={s === active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              s === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${s}`)}
          </Link>
        ))}
      </nav>
      {children}
    </section>
  )
}

export const selectClass =
  'h-9 min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
