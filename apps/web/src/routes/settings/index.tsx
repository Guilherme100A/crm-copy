// Hub `/settings?tab=` (spec 16 §2.1): abas vindas do registro `features/settings/tabs.ts`, filtradas pela sessão.
// Aba ausente ou não permitida → a primeira visível (replace). As tarefas de configurações registram as abas.
// No mobile (spec 16 §1; AC-T53-05) o menu vira um select pesquisável "Selecione a categoria".
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Search } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { SETTINGS_GROUPS, SETTINGS_TABS, type SettingsTab } from '@/features/settings/tabs'
import { useT } from '@/i18n'
import { hasAny, type Session } from '@/lib/session'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/settings/')({
  validateSearch: z.object({ tab: z.string().optional().catch(undefined), company_tab: z.string().optional().catch(undefined) }),
  component: SettingsHub,
})

const lazyCache = new Map<string, ReturnType<typeof lazy>>()
const lazyTab = (tab: SettingsTab) => {
  let C = lazyCache.get(tab.id)
  if (!C) lazyCache.set(tab.id, (C = lazy(tab.load)))
  return C
}

function SettingsHub() {
  const t = useT()
  const { session } = Route.useRouteContext() as { session: Session }
  const { tab } = Route.useSearch()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const tabs = useMemo(
    () => SETTINGS_TABS.filter((x) => !(session.isSupport && x.hiddenForSupport) && hasAny(session, x.permissions)),
    [session],
  )
  const active = tabs.find((x) => x.id === tab) ?? tabs[0]

  useEffect(() => {
    if (active && active.id !== tab) void navigate({ to: '/settings', search: (s: Record<string, unknown>) => ({ ...s, tab: active.id }), replace: true } as never)
  }, [active, tab, navigate])

  return (
    <section data-testid="page-settings" className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('pages.settings')}</h1>
      {tabs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">{t('pages.settingsEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          {!isDesktop ? (
            <TabSelect tabs={tabs} active={active} onPick={(id) => void navigate({ to: '/settings', search: { tab: id } } as never)} />
          ) : (
          <nav aria-label={t('pages.settingsTabs')} className="flex gap-1 overflow-x-auto lg:w-56 lg:flex-col">
            {SETTINGS_GROUPS.map((g) =>
              tabs
                .filter((x) => x.group === g)
                .map((x) => (
                  <Link
                    key={x.id}
                    to={'/settings' as never}
                    search={{ tab: x.id } as never}
                    data-testid={`settings-tab-${x.id}`}
                    className={cn('rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent', x.id === active?.id && 'bg-accent font-medium')}
                  >
                    {t(x.labelKey)}
                  </Link>
                )),
            )}
          </nav>
          )}
          <div className="min-w-0 flex-1">
            {active ? (
              <Suspense fallback={<div className="h-32 animate-pulse rounded-lg bg-muted" />}>
                {(() => {
                  const C = lazyTab(active)
                  return <C />
                })()}
              </Suspense>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}

const normalize = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Select pesquisável das abas (mobile): botão com a aba ativa, busca e lista agrupada na ordem do registro. */
function TabSelect({
  tabs,
  active,
  onPick,
}: {
  tabs: SettingsTab[]
  active: SettingsTab | undefined
  onPick: (id: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => SETTINGS_GROUPS.flatMap((g) => tabs.filter((x) => x.group === g)), [tabs])
  const shown = ordered.filter((x) => normalize(t(x.labelKey)).includes(normalize(query.trim())))

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const pick = (id: string) => {
    setOpen(false)
    setQuery('')
    onPick(id)
  }

  return (
    <div ref={ref} className="relative w-full" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        data-testid="settings-tab-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('settings-company:hub.selectCategory')}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm"
      >
        <span className="truncate">{active ? t(active.labelKey) : t('settings-company:hub.selectCategory')}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 flex max-h-80 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
          <label className="relative block border-b">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              data-testid="settings-tab-select-search"
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && shown[0]) pick(shown[0].id)
              }}
              placeholder={t('settings-company:hub.searchCategory')}
              aria-label={t('settings-company:hub.searchCategory')}
              className="h-10 w-full bg-transparent pr-3 pl-9 text-sm outline-none"
            />
          </label>
          <ul role="listbox" aria-label={t('pages.settingsTabs')} className="overflow-y-auto py-1">
            {shown.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">{t('settings-company:hub.noCategory')}</li>
            ) : null}
            {shown.map((x) => (
              <li
                key={x.id}
                role="option"
                aria-selected={x.id === active?.id}
                tabIndex={0}
                data-testid={`settings-tab-option-${x.id}`}
                onClick={() => pick(x.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pick(x.id)
                  }
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none',
                  x.id === active?.id && 'font-medium',
                )}
              >
                {t(x.labelKey)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
