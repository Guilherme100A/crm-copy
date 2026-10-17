// Aba `/settings?tab=integrations&cat=` (AC-T59-03; 19 §2.2–§2.4, §5.1): busca sem acentos, abas IA/Vendas/Rastreamento
// (tablist com ←/→ e contador de ativas), "Conectadas na sua conta" (registros com Ativo/Inativo, Editar/Testar/Excluir)
// e "Disponíveis" (catálogo com Configurar). Itens vêm do catálogo compartilhado `catalog.ts`.
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Loader2, Pencil, PlugZap, Search, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { cn } from '@/lib/utils'
import { aiKeysApi, AI_KEYS_KEY, type AiKeyProvider, type AiKeyTestResult } from './api'
import { AiKeyDeleteDialog, AiKeyDialog, TestResult } from './ai-key-dialog'
import {
  CATALOG,
  INTEGRATION_CATEGORIES,
  RECORD_SOURCES,
  type CatalogItem,
  type IntegrationCategory,
  type IntegrationModalProps,
  type IntegrationRecord,
  type RecordSource,
} from './catalog'
import { activeCounts, matchesSearch, nextCategory, parseCategory } from './hub-logic'

const NS = 'integrations'

type Modal =
  | { kind: 'ai-create'; provider: AiKeyProvider }
  | { kind: 'ai-edit'; record: IntegrationRecord }
  | { kind: 'ai-delete'; record: IntegrationRecord }
  | { kind: 'external'; load: NonNullable<CatalogItem['loadModal']>; props: Omit<IntegrationModalProps, 'onClose'> }

const lazyCache = new Map<unknown, ComponentType<IntegrationModalProps>>()
const lazyModal = (load: NonNullable<CatalogItem['loadModal']>) => {
  let C = lazyCache.get(load)
  if (!C) lazyCache.set(load, (C = lazy(load)))
  return C
}

export default function IntegrationsHubTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { cat?: string }
  const cat = parseCategory(search.cat)
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const companyId = session?.company?.id ?? ''
  const [term, setTerm] = useState('')
  const [modal, setModal] = useState<Modal | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, AiKeyTestResult>>({})
  const tabRefs = useRef<Partial<Record<IntegrationCategory, HTMLButtonElement | null>>>({})

  // Trocar de empresa limpa a busca (19 §2.2).
  useEffect(() => setTerm(''), [companyId])

  const sources = useMemo(() => (session ? RECORD_SOURCES.filter((s) => hasAny(session, s.viewPermissions)) : []), [session])
  const results = useQueries({ queries: sources.map((s) => ({ ...s.query(), enabled: !!companyId })) })
  const records = results.flatMap((r) => r.data ?? [])
  const loading = results.some((r) => r.isPending)
  const failed = results.some((r) => r.isError)
  const counts = activeCounts(records)
  const sourceOf = (r: IntegrationRecord) => sources.find((s) => s.id === r.sourceId)

  const catLabel = (c: IntegrationCategory) => t(`categories.${c}`)
  const catalogMatch = (i: CatalogItem) => matchesSearch([t(i.titleKey), t(i.descriptionKey), i.providerLabel, catLabel(i.category)], term)
  const recordMatch = (r: IntegrationRecord) => matchesSearch([r.title, r.providerLabel, catLabel(r.category)], term)
  const inCat = {
    records: records.filter((r) => r.category === cat),
    catalog: CATALOG.filter((i) => i.category === cat),
  }
  const shownRecords = inCat.records.filter(recordMatch)
  const shownCatalog = inCat.catalog.filter(catalogMatch)
  const searching = term.trim().length > 0

  const setCat = (c: IntegrationCategory, focus = false) => {
    void navigate({ to: '/settings', search: (s: Record<string, unknown>) => ({ ...s, tab: 'integrations', cat: c }), replace: true } as never)
    if (focus) tabRefs.current[c]?.focus()
  }

  const can = (perms: readonly string[] | undefined) => !!session && hasAny(session, perms ?? [])

  const configure = (item: CatalogItem) => {
    if (item.modalKind === 'ai') setModal({ kind: 'ai-create', provider: item.provider as AiKeyProvider })
    else if (item.loadModal) setModal({ kind: 'external', load: item.loadModal, props: { action: 'create', item } })
  }
  const edit = (r: IntegrationRecord, action: 'edit' | 'delete') => {
    const src = sourceOf(r)
    if (r.modalKind === 'ai' && r.sourceId === 'ai-keys') setModal(action === 'edit' ? { kind: 'ai-edit', record: r } : { kind: 'ai-delete', record: r })
    else if (src?.loadModal) setModal({ kind: 'external', load: src.loadModal, props: { action, record: r } })
  }
  const runTest = async (r: IntegrationRecord) => {
    setTesting(r.id)
    try {
      const res = await aiKeysApi.test(r.id)
      setTests((m) => ({ ...m, [r.id]: res }))
      void qc.invalidateQueries({ queryKey: AI_KEYS_KEY })
    } catch {
      setTests((m) => ({ ...m, [r.id]: { ok: false, latency_ms: 0, error: t('error') } }))
    } finally {
      setTesting(null)
    }
  }

  const emptyBlock = (testid: string, text: string) => (
    <p data-testid={testid} className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  )

  return (
    <section data-testid="integrations-hub" data-cat={cat} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      <label className="relative block w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          data-testid="integrations-search"
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
          className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div role="tablist" aria-label={t('categoriesLabel')} className="flex gap-1 overflow-x-auto border-b">
        {INTEGRATION_CATEGORIES.map((c) => (
          <button
            key={c}
            ref={(el) => {
              tabRefs.current[c] = el
            }}
            type="button"
            role="tab"
            id={`integrations-tab-${c}`}
            aria-selected={c === cat}
            aria-controls="integrations-panel"
            tabIndex={c === cat ? 0 : -1}
            data-testid={`integrations-cat-${c}`}
            onClick={() => setCat(c)}
            onKeyDown={(e) => {
              const next = nextCategory(cat, e.key)
              if (next) {
                e.preventDefault()
                setCat(next, true)
              }
            }}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
              c === cat ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {catLabel(c)}
            <span data-testid={`integrations-cat-count-${c}`} className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              {counts[c]}
            </span>
          </button>
        ))}
      </div>

      <div id="integrations-panel" role="tabpanel" aria-labelledby={`integrations-tab-${cat}`} className="flex flex-col gap-6">
        {failed ? <p className="text-sm text-destructive">{t('error')}</p> : null}
        {inCat.records.length === 0 && inCat.catalog.length === 0 && !loading ? (
          emptyBlock('integrations-empty-category', t('empty.category', { category: catLabel(cat) }))
        ) : searching && shownRecords.length === 0 && shownCatalog.length === 0 && !loading ? (
          emptyBlock('integrations-empty-search', t('empty.search', { term: term.trim() }))
        ) : (
          <>
            <div data-testid="integrations-section-records" className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-semibold">{t('sections.records')}</h3>
                <p className="text-xs text-muted-foreground">{t('sections.recordsHint')}</p>
              </div>
              {loading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> {t('loading')}
                </p>
              ) : shownRecords.length === 0 ? (
                emptyBlock('integrations-records-empty', searching ? t('empty.search', { term: term.trim() }) : t('empty.records', { category: catLabel(cat) }))
              ) : (
                <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {shownRecords.map((r) => (
                    <RecordCard
                      key={`${r.sourceId}-${r.id}`}
                      record={r}
                      source={sourceOf(r)}
                      can={can}
                      testing={testing === r.id}
                      test={tests[r.id]}
                      onEdit={() => edit(r, 'edit')}
                      onDelete={() => edit(r, 'delete')}
                      onTest={r.sourceId === 'ai-keys' ? () => void runTest(r) : undefined}
                    />
                  ))}
                </ul>
              )}
            </div>

            {shownCatalog.length > 0 ? (
              <div data-testid="integrations-section-catalog" className="flex flex-col gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{t('sections.catalog')}</h3>
                  <p className="text-xs text-muted-foreground">{t('sections.catalogHint')}</p>
                </div>
                <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {shownCatalog.map((i) => (
                    <CatalogCard key={i.id} item={i} canConfigure={can(i.editPermissions)} onConfigure={() => configure(i)} />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>

      {modal?.kind === 'ai-create' ? <AiKeyDialog provider={modal.provider} canTest={false} onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'ai-edit' ? (
        <AiKeyDialog record={modal.record} canTest={can(sourceOf(modal.record)?.editPermissions)} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === 'ai-delete' ? <AiKeyDeleteDialog record={modal.record} onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'external' ? <ExternalModal modal={modal} onClose={() => setModal(null)} /> : null}
    </section>
  )
}

function ExternalModal({ modal, onClose }: { modal: Extract<Modal, { kind: 'external' }>; onClose: () => void }) {
  const C = lazyModal(modal.load)
  return (
    <Suspense fallback={null}>
      <C {...modal.props} onClose={onClose} />
    </Suspense>
  )
}

function Logo({ initials }: { initials: string }) {
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">
      {initials}
    </span>
  )
}

function RecordCard({
  record: r,
  source,
  can,
  testing,
  test,
  onEdit,
  onDelete,
  onTest,
}: {
  record: IntegrationRecord
  source: RecordSource | undefined
  can: (perms: readonly string[] | undefined) => boolean
  testing: boolean
  test: AiKeyTestResult | undefined
  onEdit: () => void
  onDelete: () => void
  onTest?: () => void
}) {
  const t = useT(NS)
  const canEdit = !!source && can(source.editPermissions)
  const canDelete = !!source && can(source.deletePermissions)
  return (
    <li data-testid={`integrations-record-${r.id}`} data-source={r.sourceId} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Logo initials={r.initials} />
        <div className="min-w-0 flex-1">
          <p data-testid={`integrations-record-title-${r.id}`} className="truncate font-medium">
            {r.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {r.providerLabel}
            {r.detail ? <span className="font-mono"> · {r.detail}</span> : null}
          </p>
        </div>
        <span
          data-testid={`integrations-record-status-${r.id}`}
          data-status={r.active ? 'active' : 'inactive'}
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            r.active ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
          )}
        >
          {t(r.active ? 'status.active' : 'status.inactive')}
        </span>
      </div>
      {r.inUse ? (
        <p data-testid={`integrations-record-in-use-${r.id}`} className="text-xs text-muted-foreground">
          {t('inUse')}
        </p>
      ) : null}
      {test ? <TestResult result={test} testid={`integrations-record-test-result-${r.id}`} /> : null}
      {canEdit || canDelete ? (
        <div className="flex flex-wrap justify-end gap-2">
          {onTest && canEdit ? (
            <Button variant="outline" size="sm" data-testid={`integrations-record-test-${r.id}`} disabled={testing} onClick={onTest}>
              {testing ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
              {t('aiKey.test')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant="outline" size="sm" data-testid={`integrations-record-edit-${r.id}`} onClick={onEdit}>
              <Pencil aria-hidden /> {t('edit')}
            </Button>
          ) : null}
          {canDelete ? (
            <Button variant="outline" size="sm" data-testid={`integrations-record-delete-${r.id}`} onClick={onDelete} className="text-destructive">
              <Trash2 aria-hidden /> {t('delete')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function CatalogCard({ item, canConfigure, onConfigure }: { item: CatalogItem; canConfigure: boolean; onConfigure: () => void }) {
  const t = useT(NS)
  return (
    <li data-testid={`integrations-catalog-${item.id}`} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Logo initials={item.initials} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{t(item.titleKey)}</p>
          <p className="text-xs text-muted-foreground">{t(item.descriptionKey)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(`categories.${item.category}`)}</span>
      </div>
      <div className="flex justify-end">
        {item.comingSoon ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t('comingSoon')}</span>
        ) : canConfigure && (item.modalKind === 'ai' || item.loadModal) ? (
          <Button size="sm" data-testid={`integrations-catalog-configure-${item.id}`} onClick={onConfigure}>
            {t('configure')}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
