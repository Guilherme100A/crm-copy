// Aba Configuração (09 §2): dados do webhook, URL pública copiável, "Escutar exemplo" (90 s, `webhook.sample_received`)
// e o mapeamento: escolhe o destino, clica nos campos da árvore e concatena literais (ex.: "+55" + contact.phone).
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Copy, Ear, Plus, Save, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { webhookKey, webhooksApi, type WebhookDto } from './api'
import { JsonTree } from './json-tree'
import { useWebhookPerms } from './list-page'
import {
  addCustomField,
  appendSegment,
  configWithMapping,
  identityWarning,
  IDENTITY_TARGETS,
  mappingFromConfig,
  parseBody,
  prettyBody,
  removeSegment,
  resolveSegments,
  segmentsFor,
  type MappingState,
  type Target,
} from './mapping'
import { onSample, secondsLeft } from './realtime'
import { WebhookForm } from './webhook-form'

const field = 'h-8 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

type SampleState = 'idle' | 'listening' | 'received' | 'expired'

export function ConfigTab({ webhook }: { webhook: WebhookDto }) {
  const { canEdit } = useWebhookPerms()
  const [sampleRaw, setSampleRaw] = useState<string | null>(webhook.last_inbound_webhook_request?.raw_body ?? null)
  const sample = useMemo(() => parseBody(sampleRaw), [sampleRaw])

  return (
    <div className="flex flex-col gap-4">
      <WebhookForm webhook={webhook} />
      <UrlField url={webhook.public_receive_url} />
      <SamplePanel webhookId={webhook.id} raw={sampleRaw} onSample={setSampleRaw} />
      <MappingEditor webhook={webhook} sample={sample} readOnly={!canEdit} />
    </div>
  )
}

function UrlField({ url }: { url: string }) {
  const t = useT('settings-webhooks')
  return (
    <section className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('url.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('url.hint')}</p>
      <div className="flex min-w-0 gap-2">
        <input data-testid="webhook-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={cn(field, 'h-9 min-w-0 flex-1 font-mono text-xs')} />
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          data-testid="webhook-url-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url)
              notify('webhook-url-copied', t('url.copied'))
            } catch {
              notify('webhook-url-copy-error', t('url.copyError'))
            }
          }}
        >
          <Copy aria-hidden /> <span className="max-sm:sr-only">{t('url.copy')}</span>
        </Button>
      </div>
    </section>
  )
}

function SamplePanel({ webhookId, raw, onSample: setRaw }: { webhookId: string; raw: string | null; onSample: (raw: string) => void }) {
  const t = useT('settings-webhooks')
  const [state, setState] = useState<SampleState>('idle')
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [, tick] = useState(0)
  const [busy, setBusy] = useState(false)

  // Contagem regressiva pelo relógio do navegador (expira sem aviso do servidor).
  useEffect(() => {
    if (state !== 'listening' || !expiresAt) return
    const id = setInterval(() => {
      if (secondsLeft(expiresAt) <= 0) setState('expired')
      tick((n) => n + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [state, expiresAt])

  useEffect(
    () =>
      onSample(webhookId, (ev) => {
        setRaw(ev.request.raw_body)
        setState('received')
      }),
    [setRaw, webhookId],
  )

  const listen = async () => {
    setBusy(true)
    try {
      const r = await webhooksApi.listen(webhookId)
      setExpiresAt(r.expires_at)
      setState('listening')
    } catch {
      notify('webhook-listen-error', t('common.error'))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    setState('idle')
    setExpiresAt(null)
    await webhooksApi.stopListening(webhookId).catch(() => undefined)
  }

  return (
    <section data-testid="webhook-sample" data-state={state} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{t('sample.title')}</h2>
        {state === 'listening' && expiresAt ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 tabular-nums dark:text-amber-300">
              <span className="size-2 animate-pulse rounded-full bg-amber-500" aria-hidden />
              {t('sample.listening')} <span data-testid="webhook-listen-countdown">{secondsLeft(expiresAt)}s</span>
            </span>
            <Button variant="outline" size="sm" data-testid="webhook-listen-cancel" onClick={() => void cancel()}>
              <X aria-hidden /> {t('sample.cancel')}
            </Button>
          </>
        ) : (
          <Button size="sm" data-testid="webhook-listen" disabled={busy} onClick={() => void listen()}>
            <Ear aria-hidden /> {t('sample.listen')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('sample.hint')}</p>
      {state === 'expired' ? (
        <p data-testid="webhook-sample-expired" role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('sample.expired')}
        </p>
      ) : null}
      {state === 'received' ? (
        <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          {t('sample.received')}
        </p>
      ) : null}
      {raw !== null ? (
        <pre data-testid="webhook-sample-body" className="max-h-56 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {prettyBody(raw)}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">{t('sample.none')}</p>
      )}
    </section>
  )
}

function MappingEditor({ webhook, sample, readOnly }: { webhook: WebhookDto; sample: unknown; readOnly: boolean }) {
  const t = useT('settings-webhooks')
  const qc = useQueryClient()
  const [mapping, setMapping] = useState<MappingState>(() => mappingFromConfig(webhook.config))
  const [target, setTarget] = useState<Target>('phone')
  const [customKey, setCustomKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => setMapping(mappingFromConfig(webhook.config)), [webhook.config])

  const targets: Target[] = [...IDENTITY_TARGETS, ...mapping.custom.map((c) => `custom:${c.field_key}` as Target)]
  const label = (tg: Target) => (tg.startsWith('custom:') ? tg.slice(7) : t(`mapping.targets.${tg}`))

  const save = async () => {
    setSaving(true)
    try {
      const updated = await webhooksApi.update(webhook.id, { config: configWithMapping(webhook.config, mapping) })
      qc.setQueryData(webhookKey(webhook.id), updated)
      notify('webhook-config-saved', t('mapping.saved'))
    } catch {
      notify('webhook-config-error', t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section data-testid="webhook-mapping" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{t('mapping.title')}</h2>
        {!readOnly ? (
          <Button size="sm" data-testid="webhook-config-save" disabled={saving} onClick={() => void save()}>
            <Save aria-hidden /> {t('mapping.save')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('mapping.hint')}</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          {sample !== undefined ? (
            <JsonTree value={sample} disabled={readOnly} onPick={(path) => setMapping((m) => appendSegment(m, target, { kind: 'path', value: path }))} />
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">{t('mapping.noSample')}</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {targets.map((tg) => (
            <TargetRow
              key={tg}
              target={tg}
              label={label(tg)}
              selected={target === tg}
              readOnly={readOnly}
              mapping={mapping}
              sample={sample}
              onSelect={() => setTarget(tg)}
              onChange={setMapping}
            />
          ))}
          {!readOnly ? (
            <div className="flex gap-2">
              <input
                data-testid="webhook-map-custom-key"
                className={cn(field, 'min-w-0 flex-1')}
                placeholder={t('mapping.customPlaceholder')}
                value={customKey}
                maxLength={100}
                onChange={(e) => setCustomKey(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                data-testid="webhook-map-custom-add"
                onClick={() => {
                  const key = customKey.trim()
                  if (!key) return
                  setMapping((m) => addCustomField(m, key))
                  setTarget(`custom:${key}`)
                  setCustomKey('')
                }}
              >
                <Plus aria-hidden /> {t('mapping.customAdd')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function TargetRow({
  target,
  label,
  selected,
  readOnly,
  mapping,
  sample,
  onSelect,
  onChange,
}: {
  target: Target
  label: string
  selected: boolean
  readOnly: boolean
  mapping: MappingState
  sample: unknown
  onSelect: () => void
  onChange: (fn: (m: MappingState) => MappingState) => void
}) {
  const t = useT('settings-webhooks')
  const [literal, setLiteral] = useState('')
  const segs = segmentsFor(mapping, target)
  const identity = target === 'full_name' || target === 'phone'
  const warn = identity && identityWarning(segs, sample)
  const previewValue = sample !== undefined ? resolveSegments(sample, segs) : ''
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-2.5', selected && 'border-primary ring-1 ring-primary/40')}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`webhook-map-target-${target}`}
          aria-pressed={selected}
          onClick={onSelect}
          className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium', selected ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}
        >
          {label}
        </button>
        {identity ? <span className="text-[11px] text-muted-foreground">{t('mapping.required')}</span> : null}
      </div>
      <ul data-testid={`webhook-map-segments-${target}`} className="flex min-h-7 flex-wrap gap-1">
        {segs.length === 0 ? <li className="text-xs text-muted-foreground">{t('mapping.empty')}</li> : null}
        {segs.map((s, i) => (
          <li
            key={i}
            data-testid={`webhook-map-segment-${target}-${i}`}
            data-kind={s.kind}
            className={cn('inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]', s.kind === 'path' ? 'border-sky-500/40 bg-sky-500/10' : 'bg-muted')}
          >
            <span className="truncate">{s.kind === 'literal' ? `"${s.value}"` : s.value}</span>
            {!readOnly ? (
              <button
                type="button"
                data-testid={`webhook-map-segment-remove-${target}-${i}`}
                aria-label={t('mapping.remove')}
                onClick={() => onChange((m) => removeSegment(m, target, i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <div className="flex gap-2">
          <input
            data-testid={`webhook-map-literal-${target}`}
            className={cn(field, 'min-w-0 flex-1')}
            placeholder={t('mapping.literalPlaceholder')}
            value={literal}
            maxLength={500}
            onChange={(e) => setLiteral(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid={`webhook-map-literal-add-${target}`}
            onClick={() => {
              if (!literal) return
              onChange((m) => appendSegment(m, target, { kind: 'literal', value: literal }))
              setLiteral('')
            }}
          >
            <Plus aria-hidden /> {t('mapping.literalAdd')}
          </Button>
        </div>
      ) : null}
      <p className="text-xs">
        <span className="text-muted-foreground">{t('mapping.preview')} </span>
        <span data-testid={`webhook-map-preview-${target}`} className="font-mono break-all">
          {previewValue}
        </span>
      </p>
      {warn ? (
        <p data-testid={`webhook-map-warning-${target}`} role="alert" className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('mapping.identityWarning')}
        </p>
      ) : null}
    </div>
  )
}
