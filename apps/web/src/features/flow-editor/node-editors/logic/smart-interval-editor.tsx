// Editor do Intervalo Inteligente (AC-T57-02; 06 §3.6 `smart_interval`): por tempo (até 31 dias), por data marcada
// (horário local da empresa) ou por faixas semanais — cada dia com liga/desliga e início/fim `HH:MM`; o schema exige
// ≥ 1 dia ativo e fim depois do início, e o erro aparece no dia. Data no passado só avisa: o motor confere na execução.
import type { FlowAction } from '@crm/shared/flows'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { NodeEditorProps } from '../registry'
import { DraftStatus, ErrorText, Field, inputClass, Notice, NS, NumberInput, Select, useActionsDraft } from './kit'
import { defaultInterval, INTERVAL_UNITS, isPastLocal, patchDay, SCHEDULE_TYPES, weeklyOf, WEEKDAYS, withScheduleType } from './logic-rules'
import { ensureAction, findAction, intOf, num, setField, str } from './rules'

const TYPE = 'smart_interval'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], defaultInterval)

export function SmartIntervalEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const type = (str(c, 'schedule_type') || 'time') as (typeof SCHEDULE_TYPES)[number]
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const weekly = weeklyOf(c)
  const date = str(c, 'scheduled_date')

  return (
    <div data-testid="ne-interval" className="flex flex-col gap-2">
      <Field label={t('interval.type')} path="schedule_type" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-interval-type"
            value={type}
            options={SCHEDULE_TYPES.map((v) => ({ value: v, label: t(`interval.types.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => withScheduleType(cfg, v as (typeof SCHEDULE_TYPES)[number]))}
          />
        )}
      </Field>

      {type === 'time' ? (
        <Field label={t('interval.wait')} path="interval_value" errors={errs} hint={t('interval.maxHint')}>
          {({ id, invalid }) => (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <NumberInput id={id} testId="ne-interval-value" min={1} value={num(c, 'interval_value')} invalid={invalid} disabled={readOnly} onChange={(raw) => set('interval_value', intOf(raw))} />
              <Select
                testId="ne-interval-unit"
                value={str(c, 'interval_unit') || 'minutes'}
                options={INTERVAL_UNITS.map((u) => ({ value: u, label: t(`interval.units.${u}`) }))}
                disabled={readOnly}
                onChange={(v) => set('interval_unit', v)}
              />
            </div>
          )}
        </Field>
      ) : null}

      {type === 'date' ? (
        <>
          <Field label={t('interval.date')} path="scheduled_date" errors={errs} hint={t('interval.dateHint')}>
            {({ id, invalid }) => (
              <input
                id={id}
                type="datetime-local"
                data-testid="ne-interval-date"
                className={inputClass}
                aria-invalid={invalid}
                value={date.slice(0, 16)}
                disabled={readOnly}
                onChange={(e) => set('scheduled_date', e.target.value || undefined)}
              />
            )}
          </Field>
          {date && isPastLocal(date) ? (
            <Notice testId="ne-interval-date-past" tone="warn">
              {t('interval.datePast')}
            </Notice>
          ) : null}
        </>
      ) : null}

      {type === 'weekly' ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">{t('interval.weekly')}</p>
          <p className="text-[11px] text-muted-foreground">{t('interval.weeklyHint')}</p>
          <ul data-testid="ne-interval-days" className="flex flex-col gap-1">
            {WEEKDAYS.map((d) => {
              const day = weekly[d]
              const error = errs?.[`weekly_schedule.${d}`] ?? errs?.[`weekly_schedule.${d}.start_time`] ?? errs?.[`weekly_schedule.${d}.end_time`]
              const path = errs?.[`weekly_schedule.${d}`] ? `weekly_schedule.${d}` : errs?.[`weekly_schedule.${d}.start_time`] ? `weekly_schedule.${d}.start_time` : `weekly_schedule.${d}.end_time`
              return (
                <li key={d} data-testid={`ne-interval-day-${d}`} className="flex flex-col gap-0.5">
                  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5">
                    <label className="flex min-w-0 items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        data-testid={`ne-interval-day-${d}-enabled`}
                        className="size-4"
                        checked={day.enabled}
                        disabled={readOnly}
                        onChange={(e) => patchConfig(action.id, (cfg) => patchDay(cfg, d, { enabled: e.target.checked }))}
                      />
                      <span className="truncate">{t(`weekdays.${d}`)}</span>
                    </label>
                    {(['start', 'end'] as const).map((part) => (
                      <input
                        key={part}
                        type="time"
                        data-testid={`ne-interval-day-${d}-${part}`}
                        aria-label={`${t(`weekdays.${d}`)} · ${t(`interval.${part}`)}`}
                        className={cn(inputClass, 'px-1.5')}
                        aria-invalid={!!error}
                        value={part === 'start' ? day.start_time : day.end_time}
                        disabled={readOnly || !day.enabled}
                        onChange={(e) => patchConfig(action.id, (cfg) => patchDay(cfg, d, part === 'start' ? { start_time: e.target.value } : { end_time: e.target.value }))}
                      />
                    ))}
                  </div>
                  <ErrorText path={path} error={error} />
                </li>
              )
            })}
          </ul>
          <ErrorText path="weekly_schedule" error={errs?.weekly_schedule} />
        </div>
      ) : null}
      <DraftStatus blocked={blocked} />
    </div>
  )
}
