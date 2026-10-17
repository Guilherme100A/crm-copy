// Wizard "Novo disparo em massa" (10 §3.1, AC-T83-02/03): Dados (alvos conexão + fluxo) → Configurações (horário
// comercial, presets de velocidade, limite diário, início) → Público (seleção vinda de Contatos ou todos os
// contatos), seguido da confirmação de que o fluxo em andamento do contato será cancelado. Valida no cliente o que o
// servidor valida (réplica de `rules.ts`) e mostra os erros do servidor (`details.fields`) no passo do campo.
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { MassDispatchDraft } from '@/features/contacts/selection'
import { inputClass } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import {
  contactsTotalQuery,
  massDispatchApi,
  targetConnectionsQuery,
  triggerableFlowsQuery,
  type CreateResult,
  type QuotaDto,
} from './api'
import { Modal, NS, P, useFormat } from './dialogs'
import {
  ALL_WEEKDAYS,
  MAX_INTERVAL_SECONDS,
  SPEED_PRESETS,
  STEPS,
  applyPreset,
  buildFormData,
  effectiveInterval,
  initialForm,
  errorPathsOf,
  stepOfPath,
  validateStep,
  type FormErrors,
  type WizardForm,
  type WizardStep,
} from './logic'

const errId = (path: string) => `${P}-error-${path.replace(/\./g, '-')}`

function FieldError({ path, errors }: { path: string; errors: FormErrors }) {
  const msg = errors[path]
  if (!msg) return null
  return (
    <p data-testid={errId(path)} role="alert" className="text-xs text-destructive">
      {msg}
    </p>
  )
}

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {children}
    </label>
  )
}

export function Wizard({
  open,
  draft,
  quota,
  onClose,
  onCreated,
}: {
  open: boolean
  draft: MassDispatchDraft | null
  quota: QuotaDto | undefined
  onClose: () => void
  onCreated: (r: CreateResult) => void
}) {
  const t = useT(NS)
  const fmt = useFormat()
  const [step, setStep] = useState<WizardStep>('data')
  const [form, setForm] = useState<WizardForm>(() => initialForm(draft))
  const [errors, setErrors] = useState<FormErrors>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // Reabre limpo (e com o rascunho atual de Contatos).
  useEffect(() => {
    if (!open) return
    setStep('data')
    setForm(initialForm(draft))
    setErrors({})
    setGeneral(null)
    setConfirming(false)
  }, [open, draft])

  const connections = useQuery(targetConnectionsQuery(open))
  const flows = useQuery(triggerableFlowsQuery(open))
  const total = useQuery(contactsTotalQuery(open && !draft))
  const conns = connections.data ?? []
  const flowList = flows.data ?? []

  // 1º alvo pré-preenchido com a 1ª conexão conectada e o 1º fluxo acionável (10 §3.1).
  useEffect(() => {
    if (!open) return
    setForm((f) => {
      const first = f.targets[0]
      if (!first || (first.connection_id && first.flow_id)) return f
      const next = {
        connection_id: first.connection_id || conns[0]?.id || '',
        flow_id: first.flow_id || flowList[0]?.id || '',
      }
      if (next.connection_id === first.connection_id && next.flow_id === first.flow_id) return f
      return { ...f, targets: [next, ...f.targets.slice(1)] }
    })
  }, [open, connections.data, flows.data])

  const remaining = quota?.remaining ?? null
  const audienceCount = form.audience === 'draft' && draft ? draft.count : (total.data ?? null)
  const ctx = { remaining, audienceCount }
  const tr = (e: FormErrors): FormErrors => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, t(`errors.${v}`)]))

  const create = useMutation({
    mutationFn: () => massDispatchApi.create(buildFormData(form, draft)),
    onSuccess: (r) => {
      setConfirming(false)
      onCreated(r)
    },
    onError: (err) => {
      setConfirming(false)
      if (!(err instanceof HttpError)) return setGeneral(t('common.error'))
      const fields = (err.details as { fields?: { path: string; message: string }[] } | undefined)?.fields ?? []
      if (err.code === 'VALIDATION_ERROR' && fields.length) {
        const next: FormErrors = {}
        for (const f of fields) next[f.path] = f.message
        setErrors(next)
        setStep(stepOfPath(fields[0]!.path))
        setGeneral(null)
        return
      }
      if (err.code === 'SESSION_NOT_CONNECTED') {
        setErrors({ targets: err.message || t('errors.sessionNotConnected') })
        setStep('data')
        setGeneral(null)
        return
      }
      setGeneral(err.code === 'QUOTA_EXCEEDED' ? t('errors.noQuota') : err.message || t('common.error'))
    },
  })

  const idx = STEPS.indexOf(step)
  const goNext = () => {
    const e = validateStep(step, form, ctx)
    setErrors(tr(e))
    if (Object.keys(e).length) return
    setGeneral(null)
    setStep(STEPS[idx + 1]!)
  }
  const submit = () => {
    for (const s of STEPS) {
      const e = validateStep(s, form, ctx)
      if (Object.keys(e).length) {
        setErrors(tr(e))
        setStep(s)
        return
      }
    }
    setErrors({})
    setGeneral(null)
    setConfirming(true)
  }

  // Editar um campo some com o erro dele (os demais ficam até a próxima validação).
  const set = <K extends keyof WizardForm>(k: K, v: WizardForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    const owned = errorPathsOf(k)
    setErrors((e) => {
      const keys = Object.keys(e).filter((p) => owned.some((o) => p === o || p.startsWith(`${o}.`)))
      if (!keys.length) return e
      const next = { ...e }
      for (const p of keys) delete next[p]
      return next
    })
  }
  const warming = form.targets.some((x) => conns.find((c) => c.id === x.connection_id)?.badges?.includes('warming'))

  return (
    <>
      <Modal
        testId={`${P}-wizard`}
        open={open}
        wide
        title={t('wizard.title')}
        onClose={onClose}
        footer={
          <>
            <Button variant="outline" data-testid={`${P}-wizard-cancel`} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {idx > 0 ? (
              <Button variant="outline" data-testid={`${P}-wizard-back`} onClick={() => setStep(STEPS[idx - 1]!)}>
                {t('wizard.back')}
              </Button>
            ) : null}
            {idx < STEPS.length - 1 ? (
              <Button data-testid={`${P}-wizard-next`} onClick={goNext}>
                {t('wizard.next')}
              </Button>
            ) : (
              <Button data-testid={`${P}-wizard-submit`} disabled={create.isPending} onClick={submit}>
                {t('wizard.submit')}
              </Button>
            )}
          </>
        }
      >
        <ol className="flex flex-wrap gap-2" aria-label={t('wizard.steps')}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              data-testid={`${P}-step-indicator-${s}`}
              aria-current={s === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
                s === step ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground',
              )}
            >
              <span className="tabular-nums">{i + 1}</span>
              {t(`wizard.step.${s}`)}
            </li>
          ))}
        </ol>

        {step === 'data' ? (
          <div data-testid={`${P}-step-data`} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-name">{t('fields.name')}</Label>
              <input
                id="md-name"
                data-testid={`${P}-name`}
                className={inputClass}
                value={form.name}
                maxLength={120}
                placeholder={t('fields.namePlaceholder')}
                onChange={(e) => set('name', e.target.value)}
              />
              <FieldError path="name" errors={errors} />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t('fields.targets')}</span>
              <p className="text-xs text-muted-foreground">{t('fields.targetsHint')}</p>
              {connections.isError || flows.isError ? (
                <p data-testid={`${P}-targets-load-error`} role="alert" className="text-sm text-destructive">
                  {t('errors.targetsLoad')}
                </p>
              ) : connections.isSuccess && conns.length === 0 ? (
                <p
                  data-testid={`${P}-targets-no-connections`}
                  className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
                >
                  {t('fields.noConnections')}{' '}
                  <Link to="/connections" className="underline">
                    {t('fields.goConnections')}
                  </Link>
                </p>
              ) : null}
              {flows.isSuccess && flowList.length === 0 ? (
                <p
                  data-testid={`${P}-targets-no-flows`}
                  className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
                >
                  {t('fields.noFlows')}
                </p>
              ) : null}
              <ul className="flex flex-col gap-2">
                {form.targets.map((target, i) => (
                  <li
                    key={i}
                    data-testid={`${P}-target-${i}`}
                    className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <Label htmlFor={`md-conn-${i}`}>{t('fields.connection')}</Label>
                      <select
                        id={`md-conn-${i}`}
                        data-testid={`${P}-target-connection-${i}`}
                        className={inputClass}
                        value={target.connection_id}
                        onChange={(e) =>
                          set(
                            'targets',
                            form.targets.map((x, j) => (j === i ? { ...x, connection_id: e.target.value } : x)),
                          )
                        }
                      >
                        <option value="">{t('fields.select')}</option>
                        {conns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.phone_number ? `${c.name} (${c.phone_number})` : c.name}
                          </option>
                        ))}
                      </select>
                      <FieldError path={`targets.${i}.connection_id`} errors={errors} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <Label htmlFor={`md-flow-${i}`}>{t('fields.flow')}</Label>
                      <select
                        id={`md-flow-${i}`}
                        data-testid={`${P}-target-flow-${i}`}
                        className={inputClass}
                        value={target.flow_id}
                        onChange={(e) =>
                          set(
                            'targets',
                            form.targets.map((x, j) => (j === i ? { ...x, flow_id: e.target.value } : x)),
                          )
                        }
                      >
                        <option value="">{t('fields.select')}</option>
                        {flowList.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                      <FieldError path={`targets.${i}.flow_id`} errors={errors} />
                    </div>
                    <div className="flex items-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`${P}-target-remove-${i}`}
                        aria-label={t('fields.removeTarget')}
                        disabled={form.targets.length <= 1}
                        onClick={() =>
                          set(
                            'targets',
                            form.targets.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <FieldError path="targets" errors={errors} />
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`${P}-target-add`}
                  disabled={form.targets.length >= Math.max(1, conns.length)}
                  onClick={() =>
                    set('targets', [...form.targets, { connection_id: '', flow_id: flowList[0]?.id ?? '' }])
                  }
                >
                  <Plus aria-hidden /> {t('fields.addTarget')}
                </Button>
              </div>
            </div>
          </div>
        ) : step === 'settings' ? (
          <div data-testid={`${P}-step-settings`} className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid={`${P}-business-hours`}
                checked={form.business_hours}
                onChange={(e) => set('business_hours', e.target.checked)}
                className="size-4"
              />
              {t('fields.businessHours')}
            </label>
            {form.business_hours ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{t('fields.weekdays')}</span>
                  <div className="flex flex-wrap gap-1" role="group" aria-label={t('fields.weekdays')}>
                    {ALL_WEEKDAYS.map((d) => {
                      const on = form.weekdays.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          data-testid={`${P}-weekday-${d}`}
                          aria-pressed={on}
                          onClick={() =>
                            set('weekdays', on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d])
                          }
                          className={cn(
                            'h-8 min-w-12 rounded-md border px-2 text-xs capitalize',
                            on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                          )}
                        >
                          {fmt.weekday(d)}
                        </button>
                      )
                    })}
                  </div>
                  <FieldError path="weekdays" errors={errors} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="md-start">{t('fields.windowStart')}</Label>
                    <input
                      id="md-start"
                      type="time"
                      data-testid={`${P}-window-start`}
                      className={inputClass}
                      value={form.window_start}
                      onChange={(e) => set('window_start', e.target.value)}
                    />
                    <FieldError path="window_start" errors={errors} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="md-end">{t('fields.windowEnd')}</Label>
                    <input
                      id="md-end"
                      type="time"
                      data-testid={`${P}-window-end`}
                      className={inputClass}
                      value={form.window_end}
                      onChange={(e) => set('window_end', e.target.value)}
                    />
                    <FieldError path="window_end" errors={errors} />
                  </div>
                </div>
              </>
            ) : (
              <p data-testid={`${P}-full-day`} className="text-xs text-muted-foreground">
                {t('fields.fullDay')}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('fields.speed')}</span>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-4" role="radiogroup" aria-label={t('fields.speed')}>
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={form.preset === p}
                    data-testid={`${P}-preset-${p}`}
                    onClick={() => setForm((f) => applyPreset(f, p))}
                    className={cn(
                      'flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm',
                      form.preset === p ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent',
                    )}
                  >
                    <span className="font-medium">{t(`presets.${p}`)}</span>
                    <span className="text-xs text-muted-foreground">{t(`presets.${p}Hint`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`${P}-randomize`}
                checked={form.randomize}
                onChange={(e) => set('randomize', e.target.checked)}
                className="size-4"
              />
              {t('fields.randomize')}
            </label>
            {form.preset === 'custom' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="md-min">{t('fields.intervalMin', { s: form.interval_min })}</Label>
                  <input
                    id="md-min"
                    type="range"
                    min={0}
                    max={MAX_INTERVAL_SECONDS}
                    step={1}
                    data-testid={`${P}-interval-min`}
                    value={form.interval_min}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setForm((f) => ({ ...f, interval_min: v, interval_max: Math.max(v, f.interval_max) }))
                    }}
                  />
                  <FieldError path="interval_min_seconds" errors={errors} />
                </div>
                {form.randomize ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="md-max">{t('fields.intervalMax', { s: form.interval_max })}</Label>
                    <input
                      id="md-max"
                      type="range"
                      min={0}
                      max={MAX_INTERVAL_SECONDS}
                      step={1}
                      data-testid={`${P}-interval-max`}
                      value={form.interval_max}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setForm((f) => ({ ...f, interval_max: v, interval_min: Math.min(v, f.interval_min) }))
                      }}
                    />
                    <FieldError path="interval_max_seconds" errors={errors} />
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <FieldError path="interval_min_seconds" errors={errors} />
                <FieldError path="interval_max_seconds" errors={errors} />
              </>
            )}
            <IntervalSummary form={form} />

            <div
              data-testid={`${P}-pace-notice`}
              role="note"
              className="flex gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm"
            >
              <Info className="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden />
              <span>{t('pace.notice')}</span>
            </div>
            {warming ? (
              <div
                data-testid={`${P}-warming-notice`}
                role="note"
                className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                <span>{t('pace.warming')}</span>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="md-daily">{t('fields.dailyLimit')}</Label>
                <input
                  id="md-daily"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  data-testid={`${P}-daily-limit`}
                  className={inputClass}
                  value={form.daily_limit}
                  placeholder={t('fields.dailyLimitPlaceholder')}
                  onChange={(e) => set('daily_limit', e.target.value)}
                />
                {errors.daily_limit ? null : (
                  <p className="text-xs text-muted-foreground">
                    {remaining !== null ? t('fields.dailyLimitHint', { remaining }) : t('fields.dailyLimitHintNoQuota')}
                  </p>
                )}
                <FieldError path="daily_limit" errors={errors} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="md-starts">{t('fields.startsAt')}</Label>
                <input
                  id="md-starts"
                  type="datetime-local"
                  data-testid={`${P}-starts-at`}
                  className={inputClass}
                  value={form.starts_at}
                  onChange={(e) => set('starts_at', e.target.value)}
                />
                {errors.starts_scheduling_at ? null : (
                  <p className="text-xs text-muted-foreground">{t('fields.startsAtHint')}</p>
                )}
                <FieldError path="starts_scheduling_at" errors={errors} />
              </div>
            </div>
            <FieldError path="time_zone" errors={errors} />
          </div>
        ) : (
          <div data-testid={`${P}-step-audience`} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('fields.audience')}>
              {draft ? (
                <AudienceOption
                  testId={`${P}-audience-draft`}
                  checked={form.audience === 'draft'}
                  onSelect={() => set('audience', 'draft')}
                  title={t('audience.draft')}
                  hint={t('audience.draftCount', { n: draft.count })}
                />
              ) : null}
              <AudienceOption
                testId={`${P}-audience-all`}
                checked={form.audience === 'all'}
                onSelect={() => set('audience', 'all')}
                title={t('audience.all')}
                hint={
                  total.data !== undefined && total.data !== null
                    ? t('audience.allCount', { n: total.data })
                    : t('audience.allHint')
                }
              />
            </div>
            <p data-testid={`${P}-audience-count`} data-count={audienceCount ?? undefined} className="text-sm">
              {audienceCount !== null ? t('audience.selected', { n: audienceCount }) : t('audience.unknown')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('audience.fromContacts')}{' '}
              <Link to="/customers" data-testid={`${P}-audience-contacts-link`} className="underline">
                {t('audience.goContacts')}
              </Link>
            </p>
            <FieldError path="manifest" errors={errors} />
            <FieldError path="quota" errors={errors} />
          </div>
        )}

        {general ? (
          <p data-testid={`${P}-wizard-error`} role="alert" className="text-sm text-destructive">
            {general}
          </p>
        ) : null}
      </Modal>

      <Modal
        testId={`${P}-confirm`}
        open={confirming}
        title={t('confirm.title')}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="outline" data-testid={`${P}-confirm-back`} onClick={() => setConfirming(false)}>
              {t('wizard.back')}
            </Button>
            <Button data-testid={`${P}-confirm-ok`} disabled={create.isPending} onClick={() => create.mutate()}>
              {t('confirm.ok')}
            </Button>
          </>
        }
      >
        <p data-testid={`${P}-confirm-summary`} className="text-sm">
          {t('confirm.summary', { n: audienceCount ?? '?', targets: form.targets.length })}
        </p>
        <div
          data-testid={`${P}-confirm-flow-notice`}
          role="note"
          className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>{t('confirm.flowNotice')}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t('pace.notice')}</p>
      </Modal>
    </>
  )
}

function IntervalSummary({ form }: { form: WizardForm }) {
  const t = useT(NS)
  const { min, max } = effectiveInterval(form)
  return (
    <p data-testid={`${P}-interval-summary`} data-min={min} data-max={max} className="text-xs text-muted-foreground">
      {min === max ? t('fields.intervalFixed', { s: min }) : t('fields.intervalRange', { min, max })}
    </p>
  )
}

function AudienceOption({
  testId,
  checked,
  onSelect,
  title,
  hint,
}: {
  testId: string
  checked: boolean
  onSelect: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start rounded-lg border p-3 text-left text-sm',
        checked ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent',
      )}
    >
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
