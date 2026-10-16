// Seletor de empresa do shell (T36; spec 18 §5.10, spec 01 §5.8–§5.10): busca com debounce de 300 ms, páginas de
// 20 com "Carregar mais", troca de empresa (AC-T36-04) e criação de empresa. Só aparece com ao menos uma empresa.
import { Popover } from '@base-ui/react/popover'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Building2, Check, ChevronsUpDown, Loader2, Plus, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import type { Session } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { companiesApi, switchCompany } from './switch'

export const SEARCH_DEBOUNCE_MS = 300
export const companySwitcherKey = (search: string) => ['company-switcher', search] as const

/** Valor que só muda depois de `ms` sem alterações. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

function CreateCompany({ onCreated }: { onCreated: () => void }) {
  const t = useT('company-switcher')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (pending || !name.trim()) return
    setPending(true)
    setError(null)
    try {
      await companiesApi.create(name)
      setName('')
      setOpen(false)
      onCreated()
    } catch (err) {
      setError(err instanceof HttpError && err.status < 500 ? err.message : t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  if (!open)
    return (
      <button
        type="button"
        data-testid="company-switcher-create"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-primary hover:bg-accent"
      >
        <Plus className="size-4" aria-hidden /> {t('create.open')}
      </button>
    )

  return (
    <form onSubmit={submit} data-testid="company-switcher-create-form" className="flex flex-col gap-2 p-1">
      <label htmlFor="company-switcher-create-name" className="text-xs font-medium">
        {t('create.name')}
      </label>
      <input
        id="company-switcher-create-name"
        data-testid="company-switcher-create-name"
        autoFocus
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
      />
      {error ? (
        <p role="alert" data-testid="company-switcher-create-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t('create.cancel')}
        </Button>
        <Button type="submit" size="sm" data-testid="company-switcher-create-submit" disabled={pending || !name.trim()}>
          {t('create.submit')}
        </Button>
      </div>
    </form>
  )
}

function CompanyList({ session, onSwitched }: { session: Session; onSwitched: () => void }) {
  const t = useT('company-switcher')
  const queryClient = useQueryClient()
  const router = useRouter()
  const [search, setSearch] = useState('')
  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS)
  const [switching, setSwitching] = useState<string | null>(null)
  const q = useInfiniteQuery({
    queryKey: companySwitcherKey(term),
    queryFn: ({ pageParam, signal }) => companiesApi.list(pageParam, term, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page.has_more ? last.page.page + 1 : undefined),
    staleTime: 0,
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const activeId = session.company?.id

  const choose = async (id: string) => {
    if (switching) return
    if (id === activeId) return onSwitched()
    setSwitching(id)
    try {
      await switchCompany(queryClient, router, id)
      onSwitched()
    } catch {
      notify('company-switcher-error', t('errors.switch'))
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          data-testid="company-switcher-search"
          aria-label={t('search')}
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full rounded-md border bg-background pr-2 pl-8 text-sm"
        />
      </div>
      <div data-testid="company-switcher-list" className="max-h-72 overflow-y-auto" role="listbox" aria-label={t('label')}>
        {q.isPending ? (
          <div data-testid="company-switcher-loading" className="flex flex-col gap-1 p-1" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : q.isError ? (
          <div data-testid="company-switcher-error" className="flex flex-col items-start gap-2 p-2 text-sm">
            <p className="text-destructive">{t('errors.load')}</p>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              {t('errors.retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p data-testid="company-switcher-empty" className="p-2 text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          items.map((c) => {
            const active = c.id === activeId
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={active}
                data-testid={`company-switcher-item-${c.id}`}
                data-active={active ? 'true' : 'false'}
                disabled={!!switching}
                onClick={() => void choose(c.id)}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-60', active && 'bg-accent/60')}
              >
                <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t(`roles.${c.role}`)}</span>
                </span>
                {switching === c.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : active ? <Check className="size-4 text-primary" aria-hidden /> : null}
              </button>
            )
          })
        )}
        {q.hasNextPage ? (
          <button
            type="button"
            data-testid="company-switcher-load-more"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
            className="mt-1 w-full rounded-md px-2 py-2 text-center text-sm text-primary hover:bg-accent disabled:opacity-60"
          >
            {q.isFetchingNextPage ? t('loading') : t('loadMore')}
          </button>
        ) : null}
      </div>
      <div className="border-t pt-2">
        <CreateCompany onCreated={() => void queryClient.invalidateQueries({ queryKey: ['company-switcher'] })} />
      </div>
    </div>
  )
}

export function CompanySwitcher({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const t = useT('company-switcher')
  const [open, setOpen] = useState(false)
  if (!session.company || session.companies.length === 0) return null
  const name = session.company.name

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="company-switcher-trigger"
        aria-label={t('open')}
        title={collapsed ? name : undefined}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-md border text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          collapsed ? 'size-10 justify-center self-center' : 'w-full px-3 py-2',
        )}
      >
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn('min-w-0 flex-1', collapsed && 'sr-only')}>
          <span className="block text-xs text-muted-foreground">{t('active')}</span>
          <span data-testid="company-switcher-current" className="block truncate font-medium">
            {name}
          </span>
        </span>
        {collapsed ? null : <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" collisionPadding={8} className="z-[60]">
          <Popover.Popup data-testid="company-switcher-popup" className="w-[min(20rem,calc(100vw-2rem))] rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg outline-none">
            <Popover.Title className="mb-2 px-1 text-sm font-semibold">{t('label')}</Popover.Title>
            <CompanyList session={session} onSwitched={() => setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
