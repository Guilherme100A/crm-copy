// Horários de Trabalho (16 §3.3, §5 "Horários"): select da conexão (com status), sistema ativo/desativado, ação fora
// do horário (mensagem ou fluxo) e grade semanal com vários intervalos por dia. Salvamento explícito pelo botão
// "Salvar" do topo; a validação é a mesma do servidor e o PUT substitui config e intervalos.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { can, inputClass, LoadError, Loading, Switch, useSession } from '@/features/settings-company/ui'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  connectionsQuery,
  flowsQuery,
  hoursApi,
  hoursKey,
  hoursQuery,
  type BusinessHoursDto,
  type ConnectionOption,
  type ConnectionStatus,
} from './api'
import {
  addInterval,
  DAYS,
  hoursErrors,
  MAX_INTERVALS,
  setDayActive,
  sortByDay,
  type HoursError,
  type HoursForm,
  type Interval,
} from './validation'

const STATUS_TONE: Record<ConnectionStatus, string> = {
  connected: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  connecting: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  paused: 'bg-muted text-muted-foreground',
  disconnected: 'bg-destructive/15 text-destructive',
  banned: 'bg-destructive/15 text-destructive',
}

export default function HoursPanel() {
  const t = useT('settings-hours')
  const conns = useQuery(connectionsQuery())
  const [picked, setPicked] = useState<string | null>(null)
  const items = conns.data?.items ?? []
  const connection = items.find((c) => c.id === picked) ?? items[0] ?? null

  if (conns.isPending) return <Loading />
  if (conns.isError) return <LoadError testId="hours-error" onRetry={() => void conns.refetch()} />
  if (conns.data.forbidden)
    return (
      <p
        data-testid="hours-no-permission"
        className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        {t('noConnectionsPermission')}
      </p>
    )
  if (!connection)
    return (
      <p
        data-testid="hours-no-connections"
        className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        {t('noConnections')}
      </p>
    )

  return <ConfigLoader key={connection.id} connection={connection} connections={items} onPick={setPicked} />
}

function ConfigLoader({
  connection,
  connections,
  onPick,
}: {
  connection: ConnectionOption
  connections: ConnectionOption[]
  onPick: (id: string) => void
}) {
  const q = useQuery(hoursQuery(connection.id))
  const picker = <ConnectionPicker connection={connection} connections={connections} onPick={onPick} />
  if (q.isPending)
    return (
      <div className="flex flex-col gap-4">
        {picker}
        <Loading />
      </div>
    )
  if (q.isError)
    return (
      <div className="flex flex-col gap-4">
        {picker}
        <LoadError testId="hours-error" onRetry={() => void q.refetch()} />
      </div>
    )
  return <HoursEditor key={q.data.updated_at ?? 'new'} connectionId={connection.id} config={q.data} picker={picker} />
}

function ConnectionPicker({
  connection,
  connections,
  onPick,
}: {
  connection: ConnectionOption
  connections: ConnectionOption[]
  onPick: (id: string) => void
}) {
  const t = useT('settings-hours')
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="hours-connection" className="text-sm font-medium">
        {t('connection')} <span className="text-destructive">*</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="hours-connection"
          data-testid="hours-connection"
          className={cn(inputClass, 'min-w-0 flex-1 sm:max-w-sm')}
          value={connection.id}
          onChange={(e) => onPick(e.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {t(`status.${c.status}`)}
            </option>
          ))}
        </select>
        <span
          data-testid="hours-connection-status"
          data-status={connection.status}
          className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[connection.status])}
        >
          {t(`status.${connection.status}`)}
        </span>
      </div>
    </div>
  )
}

const formFrom = (c: BusinessHoursDto): HoursForm => ({
  active: c.active,
  action_type: c.action_type,
  message_text: c.message_text ?? '',
  flow_id: c.flow_id ?? '',
  business_hours: sortByDay(
    c.business_hours.map((h) => ({
      day_of_week: h.day_of_week,
      start_time: h.start_time,
      end_time: h.end_time,
      active: h.active,
    })),
  ),
})

function HoursEditor({
  connectionId,
  config,
  picker,
}: {
  connectionId: string
  config: BusinessHoursDto
  picker: ReactNode
}) {
  const t = useT('settings-hours')
  const qc = useQueryClient()
  const session = useSession()
  const canEdit = can(session, 'settings.business_hours.edit')
  const flows = useQuery({ ...flowsQuery(), enabled: canEdit || !!config.flow_id })
  const [form, setForm] = useState<HoursForm>(() => formFrom(config))
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const errors = useMemo(() => hoursErrors(form), [form])

  const update = (patch: Partial<HoursForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setServerErrors({})
  }
  const setRow = (i: number, patch: Partial<Interval>) =>
    update({ business_hours: form.business_hours.map((h, j) => (j === i ? { ...h, ...patch } : h)) })
  const errorText = (path: string): string | null => {
    if (serverErrors[path]) return serverErrors[path]!
    const code: HoursError | undefined = errors[path]
    // Erros de horário aparecem enquanto se digita; os de config só depois de tentar salvar.
    if (!code || (!showErrors && !path.startsWith('business_hours.'))) return null
    return t(`errors.${code}`, { max: MAX_INTERVALS })
  }

  async function save() {
    setShowErrors(true)
    if (Object.keys(errors).length) {
      notify('hours-invalid', t('invalid'))
      return
    }
    setSaving(true)
    try {
      const saved = await hoursApi.save(connectionId, form)
      qc.setQueryData(hoursKey(connectionId), saved)
      notify('hours-saved', t('saved'))
    } catch (err) {
      const fields =
        err instanceof HttpError && err.code === 'VALIDATION_ERROR'
          ? ((err.details as { fields?: { path: string; message: string }[] } | undefined)?.fields ?? [])
          : []
      setServerErrors(Object.fromEntries(fields.map((f) => [f.path, f.message])))
      notify('hours-error', t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  const byDay = (day: number) => form.business_hours.map((h, i) => ({ h, i })).filter((x) => x.h.day_of_week === day)

  return (
    <div data-testid="hours-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canEdit ? (
          <Button data-testid="hours-save" disabled={saving} onClick={() => void save()}>
            <Save aria-hidden /> {t('save')}
          </Button>
        ) : null}
      </div>
      {canEdit ? <p className="text-xs text-muted-foreground">{t('saveHint')}</p> : null}
      {picker}

      <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div>
          <p data-testid="hours-active-label" className="text-sm font-medium">
            {form.active ? t('activeOn') : t('activeOff')}
          </p>
          <p className="text-xs text-muted-foreground">{t('activeHint')}</p>
        </div>
        <Switch
          testId="hours-active"
          label={t('active')}
          checked={form.active}
          disabled={!canEdit}
          onChange={(v) => update({ active: v })}
        />
      </div>

      <fieldset className="flex flex-col gap-3 rounded-xl border bg-card p-4" disabled={!canEdit}>
        <legend className="px-1 text-sm font-medium">{t('actionType')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['message', 'flow'] as const).map((a) => (
            <label key={a} className="flex items-center gap-2">
              <input
                type="radio"
                name="hours-action"
                data-testid={`hours-action-${a}`}
                checked={form.action_type === a}
                onChange={() => update({ action_type: a })}
              />
              <span>
                {t(`action.${a}`)} <span className="text-xs text-muted-foreground">— {t(`action.${a}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
        {form.action_type === 'message' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="hours-message" className="text-sm font-medium">
              {t('message')}
            </label>
            <textarea
              id="hours-message"
              data-testid="hours-message"
              className={cn(inputClass, 'h-auto min-h-20 py-2')}
              maxLength={4096}
              value={form.message_text}
              placeholder={t('messagePlaceholder')}
              onChange={(e) => update({ message_text: e.target.value })}
            />
            <FieldError testId="hours-message-error" text={errorText('message_text')} />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="hours-flow" className="text-sm font-medium">
              {t('flow')}
            </label>
            <select
              id="hours-flow"
              data-testid="hours-flow"
              className={cn(inputClass, 'sm:max-w-sm')}
              value={form.flow_id}
              onChange={(e) => update({ flow_id: e.target.value })}
            >
              <option value="">{t('flowPlaceholder')}</option>
              {(flows.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <FieldError testId="hours-flow-error" text={errorText('flow_id')} />
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-xl border bg-card p-4" disabled={!canEdit}>
        <legend className="px-1 text-sm font-medium">{t('schedule')}</legend>
        <p className="text-xs text-muted-foreground">{t('scheduleHint')}</p>
        <FieldError testId="hours-intervals-error" text={errorText('business_hours')} />
        <ul className="flex flex-col divide-y">
          {DAYS.map((day) => {
            const rows = byDay(day)
            const dayOn = rows.some((x) => x.h.active)
            return (
              <li
                key={day}
                data-testid={`hours-day-${day}`}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start"
              >
                <div className="flex w-40 shrink-0 items-center gap-2">
                  <Switch
                    testId={`hours-day-toggle-${day}`}
                    label={t(`days.${day}`)}
                    checked={dayOn}
                    disabled={!canEdit || rows.length === 0}
                    onChange={(v) => update({ business_hours: setDayActive(form.business_hours, day, v) })}
                  />
                  <span className={cn('text-sm font-medium', !dayOn && 'text-muted-foreground')}>
                    {t(`days.${day}`)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t('closed')}</p> : null}
                  {rows.map(({ h, i }) => {
                    const err =
                      errorText(`business_hours.${i}.start_time`) ??
                      errorText(`business_hours.${i}.end_time`) ??
                      errorText(`business_hours.${i}.day_of_week`)
                    return (
                      <div key={i} data-testid={`hours-interval-${i}`} data-day={day} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            data-testid={`hours-interval-start-${i}`}
                            aria-label={t('start')}
                            aria-invalid={!!errorText(`business_hours.${i}.start_time`)}
                            className={cn(inputClass, 'w-24 tabular-nums', !h.active && 'opacity-60')}
                            inputMode="numeric"
                            placeholder="HH:MM"
                            maxLength={5}
                            value={h.start_time}
                            onChange={(e) => setRow(i, { start_time: e.target.value })}
                          />
                          <span className="text-sm text-muted-foreground">{t('until')}</span>
                          <input
                            data-testid={`hours-interval-end-${i}`}
                            aria-label={t('end')}
                            aria-invalid={!!errorText(`business_hours.${i}.end_time`)}
                            className={cn(inputClass, 'w-24 tabular-nums', !h.active && 'opacity-60')}
                            inputMode="numeric"
                            placeholder="HH:MM"
                            maxLength={5}
                            value={h.end_time}
                            onChange={(e) => setRow(i, { end_time: e.target.value })}
                          />
                          {canEdit ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive"
                              data-testid={`hours-interval-remove-${i}`}
                              aria-label={t('remove')}
                              onClick={() => update({ business_hours: form.business_hours.filter((_, j) => j !== i) })}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                        <FieldError testId={`hours-interval-error-${i}`} text={err} />
                      </div>
                    )
                  })}
                  {canEdit ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      data-testid={`hours-add-${day}`}
                      disabled={form.business_hours.length >= MAX_INTERVALS}
                      onClick={() => update({ business_hours: addInterval(form.business_hours, day) })}
                    >
                      <Plus aria-hidden /> {t('add')}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </fieldset>
    </div>
  )
}

function FieldError({ text, testId }: { text: string | null; testId: string }) {
  return text ? (
    <p data-testid={testId} className="text-xs text-destructive">
      {text}
    </p>
  ) : null
}
