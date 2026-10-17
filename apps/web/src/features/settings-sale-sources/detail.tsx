// Detalhe da fonte de venda (AC-T90-02/03): dados gerais, URL de recebimento copiável com rotação do token (pede
// confirmação), segredo HMAC (gerado no navegador, mostrado uma única vez com copiar; depois só "configurado"),
// mapeamento JSONPath → `SaleEvent` com mapa de status, teste da amostra colada (dry-run no servidor) e o log de eventos.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, FlaskConical, KeyRound, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { inputClass, isFieldError, serverMessage, textareaClass, usePerms } from '@/features/settings-quick-replies/kit'
import { productsQuery } from '@/features/settings-products/api'
import { formatMoney } from '@/features/settings-products/rules'
import { SALE_SOURCES_KEY, saleSourceQuery, saleSourcesApi, type SaleSourceDto, type TestResult } from './api'
import { EventsLog } from './events'
import {
  AMOUNT_UNITS,
  childPath,
  cleanMapping,
  generateSecret,
  mappingIssues,
  parseSample,
  REQUIRED_SALE_EVENT_FIELDS,
  SALE_EVENT_FIELDS,
  SALE_EVENT_STATUSES,
  SIGNATURE_HEADER,
  signBody,
  SOURCE_NAME_MAX,
  statusMapFrom,
  statusRowsFrom,
  validSourceName,
  type AmountUnit,
  type MappingDraft,
  type SaleEventField,
  type StatusRow,
} from './rules'
import { ConfirmAction, CopyField, NS, Section } from './ui'

const P = 'sale-sources'

export function SaleSourceDetail({
  id,
  initialSecret,
  onBack,
}: {
  id: string
  initialSecret: string | null
  onBack: () => void
}) {
  const t = useT(NS)
  const q = useQuery(saleSourceQuery(id))
  return (
    <section data-testid="sale-sources-detail" className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="sm" data-testid={`${P}-back`} onClick={onBack}>
          <ArrowLeft aria-hidden /> {t('detail.back')}
        </Button>
      </div>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('common.error')}</p>
      ) : (
        <DetailBody key={q.data.id} source={q.data} initialSecret={initialSecret} />
      )}
    </section>
  )
}

function DetailBody({ source, initialSecret }: { source: SaleSourceDto; initialSecret: string | null }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit } = usePerms(['settings.integrations.edit'], ['settings.integrations.delete'])
  const [name, setName] = useState(source.name)
  const [active, setActive] = useState(source.active)
  const [unit, setUnit] = useState<AmountUnit>(source.amount_unit)
  const [mapping, setMapping] = useState<MappingDraft>(source.mapping)
  const [statusRows, setStatusRows] = useState<StatusRow[]>(() => statusRowsFrom(source.status_map))
  const [secret, setSecret] = useState<string | null>(initialSecret)
  const [sample, setSample] = useState('')
  const [tried, setTried] = useState(false)
  const issues = tried ? mappingIssues(mapping) : {}
  const nameInvalid = tried && !validSourceName(name)

  const putCache = (s: SaleSourceDto) => {
    qc.setQueryData(saleSourceQuery(s.id).queryKey, s)
    void qc.invalidateQueries({ queryKey: [...SALE_SOURCES_KEY, 'list'] })
  }
  const save = useMutation({
    mutationFn: () =>
      saleSourcesApi.update(source.id, {
        name: name.trim(),
        active,
        amount_unit: unit,
        mapping: cleanMapping(mapping),
        status_map: statusMapFrom(statusRows),
      }),
    onSuccess: (s) => {
      putCache(s)
      notify('sale-sources-saved', t('detail.saved'))
    },
  })
  const nameError = isFieldError(save.error, 'name')
    ? serverMessage(save.error, 'name')
    : nameInvalid
      ? t('errors.name')
      : null

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h2 data-testid={`${P}-detail-name`} className="min-w-0 flex-1 text-xl font-semibold break-words">
          {source.name}
        </h2>
        {canEdit ? (
          <Button
            data-testid={`${P}-save`}
            disabled={save.isPending}
            onClick={() => {
              setTried(true)
              if (!validSourceName(name) || Object.keys(mappingIssues(mapping)).length) return
              save.mutate()
            }}
          >
            <Save aria-hidden /> {t('detail.save')}
          </Button>
        ) : null}
      </header>
      {save.error && !isFieldError(save.error, 'name') ? (
        <p data-testid={`${P}-save-error`} role="alert" className="text-sm text-destructive">
          {serverMessage(save.error) ?? t('common.error')}
        </p>
      ) : null}

      <Section title={t('general.title')}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="font-medium">{t('fields.name')}</span>
            <input
              data-testid={`${P}-name`}
              value={name}
              maxLength={SOURCE_NAME_MAX}
              disabled={!canEdit}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
            {nameError ? (
              <span data-testid={`${P}-name-error`} role="alert" className="text-xs text-destructive">
                {nameError}
              </span>
            ) : null}
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="font-medium">{t('fields.amountUnit')}</span>
            <select
              data-testid={`${P}-amount-unit`}
              value={unit}
              disabled={!canEdit}
              onChange={(e) => setUnit(e.target.value as AmountUnit)}
              className={inputClass}
            >
              {AMOUNT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`amountUnit.${u}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid={`${P}-active`}
              checked={active}
              disabled={!canEdit}
              onChange={(e) => setActive(e.target.checked)}
              className="size-4"
            />
            {t('fields.active')}
          </label>
        </div>
      </Section>

      <UrlSection source={source} canEdit={canEdit} onRotated={putCache} onSecret={setSecret} />
      <SecretSection
        source={source}
        canEdit={canEdit}
        secret={secret}
        sample={sample}
        onSecret={setSecret}
        onSaved={putCache}
      />
      <MappingSection mapping={mapping} onMapping={setMapping} issues={issues} readOnly={!canEdit} />
      <StatusMapSection rows={statusRows} onRows={setStatusRows} readOnly={!canEdit} />
      <SampleSection
        sourceId={source.id}
        sample={sample}
        onSample={setSample}
        canTest={canEdit}
        draft={{ mapping: cleanMapping(mapping), status_map: statusMapFrom(statusRows), amount_unit: unit }}
        onPick={(path, field) => setMapping((m) => ({ ...m, [field]: path }))}
      />
      <EventsLog sourceId={source.id} canReplay={canEdit} />
    </div>
  )
}

function UrlSection({
  source,
  canEdit,
  onRotated,
  onSecret,
}: {
  source: SaleSourceDto
  canEdit: boolean
  onRotated: (s: SaleSourceDto) => void
  onSecret: (s: string) => void
}) {
  const t = useT(NS)
  const [confirming, setConfirming] = useState(false)
  const [withSecret, setWithSecret] = useState(true)
  return (
    <Section title={t('url.title')} hint={t('url.hint')} testid={`${P}-url-section`}>
      <CopyField testid={`${P}-url`} value={source.public_url} label={t('url.title')} />
      {canEdit ? (
        <div>
          <Button variant="outline" size="sm" data-testid={`${P}-rotate`} onClick={() => setConfirming(true)}>
            <RefreshCw aria-hidden /> {t('rotate.action')}
          </Button>
        </div>
      ) : null}
      <ConfirmAction
        prefix={`${P}-rotate`}
        open={confirming}
        title={t('rotate.title')}
        body={t('rotate.body')}
        confirmLabel={t('rotate.confirm')}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            let s = await saleSourcesApi.rotateToken(source.id)
            if (withSecret) {
              const secret = generateSecret()
              s = await saleSourcesApi.update(source.id, { hmac_secret: secret })
              onSecret(secret)
            }
            onRotated(s)
            notify('sale-sources-rotated', t('rotate.done'))
          } catch (err) {
            notify('sale-sources-error', serverMessage(err) ?? t('common.error'))
          }
          setConfirming(false)
        }}
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid={`${P}-rotate-secret`}
            checked={withSecret}
            onChange={(e) => setWithSecret(e.target.checked)}
            className="mt-0.5 size-4"
          />
          {t('rotate.withSecret')}
        </label>
      </ConfirmAction>
    </Section>
  )
}

function SecretSection({
  source,
  canEdit,
  secret,
  sample,
  onSecret,
  onSaved,
}: {
  source: SaleSourceDto
  canEdit: boolean
  secret: string | null
  sample: string
  onSecret: (s: string | null) => void
  onSaved: (s: SaleSourceDto) => void
}) {
  const t = useT(NS)
  const [confirm, setConfirm] = useState<'replace' | 'remove' | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const setSecret = async (value: string | null) => {
    try {
      const s = await saleSourcesApi.update(source.id, { hmac_secret: value })
      onSecret(value)
      onSaved(s)
    } catch (err) {
      notify('sale-sources-error', serverMessage(err) ?? t('common.error'))
    }
  }
  // Assinatura da amostra colada com o segredo recém-gerado: ajuda a testar o recebimento (`x-signature`).
  useEffect(() => {
    let alive = true
    if (!secret || !sample.trim() || !parseSample(sample).ok) {
      setSignature(null)
      return
    }
    signBody(secret, sample)
      .then((sig) => alive && setSignature(sig))
      .catch(() => alive && setSignature(null))
    return () => {
      alive = false
    }
  }, [secret, sample])

  return (
    <Section
      title={t('secret.title')}
      hint={t('secret.hint', { header: SIGNATURE_HEADER })}
      testid={`${P}-secret-section`}
    >
      <p
        data-testid={`${P}-secret-status`}
        data-configured={source.hmac_configured}
        className="flex items-center gap-2 text-sm"
      >
        <KeyRound className="size-4 text-muted-foreground" aria-hidden />
        {t(source.hmac_configured ? 'secret.configured' : 'secret.none')}
      </p>
      {secret ? (
        <div
          data-testid={`${P}-secret-reveal`}
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="flex items-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" aria-hidden /> {t('secret.once')}
          </p>
          <CopyField testid={`${P}-secret`} value={secret} label={t('secret.title')} />
          {signature ? (
            <p className="min-w-0 text-xs break-all text-muted-foreground">
              {t('secret.signature', { header: SIGNATURE_HEADER })}{' '}
              <code data-testid={`${P}-secret-signature`} className="font-mono">
                {signature}
              </code>
            </p>
          ) : null}
          <div>
            <Button variant="ghost" size="sm" data-testid={`${P}-secret-hide`} onClick={() => onSecret(null)}>
              <X aria-hidden /> {t('secret.hide')}
            </Button>
          </div>
        </div>
      ) : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-secret-generate`}
            onClick={() => (source.hmac_configured ? setConfirm('replace') : void setSecret(generateSecret()))}
          >
            <KeyRound aria-hidden /> {t(source.hmac_configured ? 'secret.replace' : 'secret.generate')}
          </Button>
          {source.hmac_configured ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              data-testid={`${P}-secret-remove`}
              onClick={() => setConfirm('remove')}
            >
              <Trash2 aria-hidden /> {t('secret.remove')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmAction
        prefix={`${P}-secret`}
        open={!!confirm}
        title={t(confirm === 'remove' ? 'secret.removeTitle' : 'secret.replaceTitle')}
        body={t(confirm === 'remove' ? 'secret.removeBody' : 'secret.replaceBody')}
        confirmLabel={t(confirm === 'remove' ? 'secret.remove' : 'secret.replace')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await setSecret(confirm === 'remove' ? null : generateSecret())
          setConfirm(null)
        }}
      />
    </Section>
  )
}

function MappingSection({
  mapping,
  onMapping,
  issues,
  readOnly,
}: {
  mapping: MappingDraft
  onMapping: (fn: (m: MappingDraft) => MappingDraft) => void
  issues: Partial<Record<SaleEventField, 'required' | 'invalid'>>
  readOnly: boolean
}) {
  const t = useT(NS)
  return (
    <Section title={t('mapping.title')} hint={t('mapping.hint')} testid={`${P}-mapping`}>
      <div className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
        {SALE_EVENT_FIELDS.map((f) => {
          const required = REQUIRED_SALE_EVENT_FIELDS.includes(f)
          const issue = issues[f]
          return (
            <label key={f} className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="flex min-w-0 items-baseline gap-1">
                <code className="font-mono text-xs">{f}</code>
                {required ? <span className="text-destructive">*</span> : null}
                <span className="min-w-0 truncate text-xs text-muted-foreground">{t(`fields.event.${f}`)}</span>
              </span>
              <input
                data-testid={`${P}-map-${f}`}
                value={mapping[f] ?? ''}
                disabled={readOnly}
                placeholder="$.campo"
                onChange={(e) => onMapping((m) => ({ ...m, [f]: e.target.value }))}
                className={cn(inputClass, 'font-mono text-xs', issue && 'border-destructive')}
                autoComplete="off"
              />
              {issue ? (
                <span data-testid={`${P}-map-error-${f}`} role="alert" className="text-xs text-destructive">
                  {t(`errors.${issue === 'required' ? 'pathRequired' : 'pathInvalid'}`)}
                </span>
              ) : null}
            </label>
          )
        })}
      </div>
      <ProductHelper />
    </Section>
  )
}

/** Seletor de produto (id interno): o processador liga a venda pelo `products.id`, enviado no campo de `product_id`. */
function ProductHelper() {
  const t = useT(NS)
  const q = useQuery(productsQuery(''))
  const [picked, setPicked] = useState('')
  if (q.isError) return null
  const items = q.data ?? []
  return (
    <div data-testid={`${P}-product-helper`} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{t('mapping.productHint')}</p>
      <select
        data-testid={`${P}-product-select`}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className={inputClass}
      >
        <option value="">{items.length ? t('mapping.productPick') : t('mapping.productNone')}</option>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {picked ? <CopyField testid={`${P}-product-id`} value={picked} label={t('mapping.productId')} /> : null}
    </div>
  )
}

function StatusMapSection({
  rows,
  onRows,
  readOnly,
}: {
  rows: StatusRow[]
  onRows: (rows: StatusRow[]) => void
  readOnly: boolean
}) {
  const t = useT(NS)
  const set = (i: number, patch: Partial<StatusRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <Section title={t('statusMap.title')} hint={t('statusMap.hint')} testid={`${P}-status-map`}>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t('statusMap.empty')}</p> : null}
      <ul className="flex min-w-0 flex-col gap-2">
        {rows.map((r, i) => (
          <li key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <input
              data-testid={`${P}-status-raw-${i}`}
              value={r.raw}
              disabled={readOnly}
              placeholder={t('statusMap.raw')}
              aria-label={t('statusMap.raw')}
              onChange={(e) => set(i, { raw: e.target.value })}
              className={cn(inputClass, 'font-mono text-xs')}
            />
            <select
              data-testid={`${P}-status-value-${i}`}
              value={r.status}
              disabled={readOnly}
              aria-label={t('statusMap.status')}
              onChange={(e) => set(i, { status: e.target.value as StatusRow['status'] })}
              className={inputClass}
            >
              {SALE_EVENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`saleStatus.${s}`)}
                </option>
              ))}
            </select>
            {readOnly ? (
              <span />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                data-testid={`${P}-status-remove-${i}`}
                aria-label={t('statusMap.remove')}
                onClick={() => onRows(rows.filter((_, j) => j !== i))}
              >
                <X aria-hidden />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-status-add`}
            onClick={() => onRows([...rows, { raw: '', status: 'approved' }])}
          >
            <Plus aria-hidden /> {t('statusMap.add')}
          </Button>
        </div>
      )}
    </Section>
  )
}

function SampleSection({
  sourceId,
  sample,
  onSample,
  canTest,
  draft,
  onPick,
}: {
  sourceId: string
  sample: string
  onSample: (s: string) => void
  canTest: boolean
  draft: { mapping: Record<string, string>; status_map: Record<string, StatusRow['status']>; amount_unit: AmountUnit }
  onPick: (path: string, field: SaleEventField) => void
}) {
  const t = useT(NS)
  const { locale } = useI18n()
  const [target, setTarget] = useState<SaleEventField>('external_id')
  const [localError, setLocalError] = useState(false)
  const parsed = useMemo(() => parseSample(sample), [sample])
  const products = useQuery({ ...productsQuery(''), enabled: canTest })
  const test = useMutation({ mutationFn: () => saleSourcesApi.test(sourceId, { sample, ...draft }) })
  const sampleServerError =
    test.error instanceof HttpError && isFieldError(test.error, 'sample') ? serverMessage(test.error, 'sample') : null
  const result: TestResult | undefined = test.data
  const productName = (id: string | null) => (id ? products.data?.find((p) => p.id === id)?.name : undefined)

  return (
    <Section title={t('sample.title')} hint={t('sample.hint')} testid={`${P}-sample-section`}>
      <textarea
        data-testid={`${P}-sample`}
        value={sample}
        onChange={(e) => {
          onSample(e.target.value)
          setLocalError(false)
          if (test.data || test.error) test.reset()
        }}
        placeholder='{"id": "123", "status": "paid", "amount": "199,90", "customer": {"phone": "+5511999990000"}}'
        spellCheck={false}
        className={cn(textareaClass, 'min-h-32 font-mono text-xs')}
      />
      {localError || sampleServerError ? (
        <p data-testid={`${P}-sample-error`} role="alert" className="text-xs text-destructive">
          {sampleServerError ?? t('sample.invalid')}
        </p>
      ) : null}
      {parsed.ok && parsed.value !== null && typeof parsed.value === 'object' ? (
        <div className="flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {t('sample.pickInto')}
            <select
              data-testid={`${P}-sample-target`}
              value={target}
              onChange={(e) => setTarget(e.target.value as SaleEventField)}
              className="h-8 min-w-0 rounded-md border bg-background px-2 font-mono text-xs"
            >
              {SALE_EVENT_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <SampleTree value={parsed.value} disabled={!canTest} onPick={(path) => onPick(path, target)} />
        </div>
      ) : null}
      {canTest ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-test`}
            disabled={test.isPending}
            onClick={() => {
              if (!parsed.ok) {
                setLocalError(true)
                return
              }
              test.mutate()
            }}
          >
            <FlaskConical aria-hidden /> {t('sample.test')}
          </Button>
        </div>
      ) : null}
      {test.error && !sampleServerError ? (
        <p data-testid={`${P}-test-error`} role="alert" className="text-xs text-destructive">
          {serverMessage(test.error) ?? t('common.error')}
        </p>
      ) : null}
      {result ? (
        <div data-testid={`${P}-test-result`} data-ok={result.ok} className="flex min-w-0 flex-col gap-2">
          {result.ok ? (
            <>
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('sample.ok')}</p>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">external_id</dt>
                <dd data-testid={`${P}-test-event-external_id`} className="min-w-0 font-mono break-all">
                  {result.event.external_id}
                </dd>
                <dt className="text-muted-foreground">status</dt>
                <dd data-testid={`${P}-test-event-status`} data-status={result.event.status}>
                  {t(`saleStatus.${result.event.status}`)}
                </dd>
                <dt className="text-muted-foreground">amount_cents</dt>
                <dd
                  data-testid={`${P}-test-event-amount`}
                  data-cents={result.event.amount_cents}
                  className="tabular-nums"
                >
                  {formatMoney(result.event.amount_cents, result.event.currency, locale)}
                </dd>
                <dt className="text-muted-foreground">phone</dt>
                <dd data-testid={`${P}-test-event-phone`} className="min-w-0 font-mono break-all">
                  {result.event.customer.phone}
                </dd>
                {result.event.product_id ? (
                  <>
                    <dt className="text-muted-foreground">product_id</dt>
                    <dd data-testid={`${P}-test-event-product`} className="min-w-0 break-all">
                      {productName(result.event.product_id) ?? (
                        <span className="font-mono text-xs">{result.event.product_id}</span>
                      )}
                    </dd>
                  </>
                ) : null}
              </dl>
              <pre
                data-testid={`${P}-test-event`}
                className="max-h-80 min-w-0 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs break-all whitespace-pre-wrap"
              >
                {JSON.stringify(result.event, null, 2)}
              </pre>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-destructive">{t('sample.failed')}</p>
              {result.missing.length ? (
                <ul data-testid={`${P}-test-missing`} className="flex flex-col gap-0.5 text-xs">
                  {result.missing.map((m) => (
                    <li
                      key={m.field}
                      data-testid={`${P}-test-missing-${m.field}`}
                      className="min-w-0 font-mono break-all"
                    >
                      {t('sample.missing', { field: m.field, path: m.path || '—' })}
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.errors.length ? (
                <ul
                  data-testid={`${P}-test-errors`}
                  className="flex flex-col gap-0.5 font-mono text-xs break-all text-destructive"
                >
                  {result.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Section>
  )
}

const preview = (v: unknown) => (typeof v === 'string' ? `"${v.length > 60 ? `${v.slice(0, 60)}…` : v}"` : String(v))

/** Árvore da amostra: clicar numa folha preenche o campo escolhido com o JSONPath (`$.a.b[0]`). */
function SampleTree({
  value,
  onPick,
  disabled,
}: {
  value: unknown
  onPick: (path: string) => void
  disabled?: boolean
}) {
  return (
    <div
      data-testid={`${P}-json-tree`}
      className="max-h-72 min-w-0 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs"
    >
      <TreeNode label={null} path="" value={value} onPick={onPick} disabled={disabled} />
    </div>
  )
}

function TreeNode({
  label,
  path,
  value,
  onPick,
  disabled,
}: {
  label: string | null
  path: string
  value: unknown
  onPick: (p: string) => void
  disabled?: boolean
}) {
  if (value === null || typeof value !== 'object')
    return (
      <button
        type="button"
        data-testid={`${P}-json-node-${path}`}
        disabled={disabled || !path}
        onClick={() => onPick(path)}
        title={path}
        className={cn(
          'flex w-full min-w-0 items-baseline gap-1 rounded px-1 py-0.5 text-left',
          !disabled && path && 'hover:bg-primary/10',
        )}
      >
        {label !== null ? <span className="shrink-0 text-sky-700 dark:text-sky-400">{label}:</span> : null}
        <span className="min-w-0 truncate text-emerald-700 dark:text-emerald-400">{preview(value)}</span>
      </button>
    )
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>)
  return (
    <div className="min-w-0">
      {label !== null ? <span className="px-1 text-sky-700 dark:text-sky-400">{label}</span> : null}
      <div className={cn('min-w-0', label !== null && 'ml-3 border-l pl-2')}>
        {entries.map(([k, v]) => (
          <TreeNode key={k} label={String(k)} path={childPath(path, k)} value={v} onPick={onPick} disabled={disabled} />
        ))}
      </div>
    </div>
  )
}
