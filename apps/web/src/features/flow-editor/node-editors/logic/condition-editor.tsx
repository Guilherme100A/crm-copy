// Editor do nó Condição (AC-T57-01; 06 §3.6 `evaluate_condition`): regras `all` (todas) / `any` (alguma) com as seis
// categorias do T41 — sistema (etiqueta, dia, hora, data, janela), atendimento, atendente, campo do contato, campo
// personalizado e variável global — e só os operadores coerentes com o tipo (`operatorsFor`). Saídas: success/failure.
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useId, useMemo } from 'react'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { customFieldsQuery, globalVariablesQuery, labelsQuery, teamQuery } from './api'
import { DraftStatus, ErrorText, Field, inputClass, ListNotice, Notice, NS, OutputsSummary, Select, smallButton, iconButton, useActionsDraft, VarText } from './kit'
import {
  ATTENDANCE_STATUSES,
  CONDITION_CATEGORIES,
  CONTACT_FIELDS,
  defaultCondition,
  defaultRule,
  isNumericOperator,
  operatorNeedsValue,
  operatorsFor,
  REPLY_TYPES,
  SYSTEM_SUBTYPES,
  systemRule,
  valueKind,
  WEEKDAYS,
  withOperator,
  type Category,
  type SystemSubtype,
} from './logic-rules'
import { ensureAction, errorsUnder, findAction, intOf, list, setField, str, strings, type Config, type FieldErrors } from './rules'

const TYPE = 'evaluate_condition'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], defaultCondition)

export function ConditionEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const rules = list(c.conditions)
  const setRules = (next: Config[]) => patchConfig(action.id, (cfg) => ({ ...cfg, conditions: next }))
  const setRule = (i: number, rule: Config) => setRules(rules.map((r, j) => (j === i ? rule : r)))

  return (
    <div data-testid="ne-condition" className="flex flex-col gap-2">
      <Field label={t('cond.ruleType')} path="ruleType" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-cond-rule-type"
            value={str(c, 'ruleType') || 'all'}
            options={(['all', 'any'] as const).map((v) => ({ value: v, label: t(`cond.ruleTypes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'ruleType', v))}
          />
        )}
      </Field>
      <ol data-testid="ne-cond-list" className="flex flex-col gap-2">
        {rules.map((rule, i) => (
          <li key={i} data-testid={`ne-cond-${i}`} className="flex min-w-0 flex-col gap-2 rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground">
                {i === 0 ? t('cond.if') : t(`cond.joiners.${str(c, 'ruleType') || 'all'}`)} · {t('cond.rule', { n: i + 1 })}
              </span>
              <button
                type="button"
                data-testid={`ne-cond-${i}-remove`}
                aria-label={t('cond.remove')}
                disabled={readOnly || rules.length <= 1}
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
                className={iconButton}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
            <RuleFields index={i} rule={rule} errors={errorsUnder(errs, `conditions.${i}`)} readOnly={readOnly} onChange={(r) => setRule(i, r)} />
          </li>
        ))}
      </ol>
      <ErrorText path="conditions" error={errs?.conditions} />
      <button type="button" data-testid="ne-cond-add" disabled={readOnly} onClick={() => setRules([...rules, defaultRule('field')])} className={smallButton}>
        <Plus className="size-3.5" aria-hidden /> {t('cond.add')}
      </button>
      <OutputsSummary type="condition" actions={draft} label={(h) => t(`outputs.handles.${h}`)} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}

function RuleFields({ index, rule, errors, readOnly, onChange }: { index: number; rule: Config; errors: FieldErrors; readOnly: boolean; onChange: (r: Config) => void }) {
  const t = useT(NS)
  const p = `conditions.${index}`
  const tid = (part: string) => `ne-cond-${index}-${part}`
  // Os erros vêm relativos à regra (`fieldName`); o testid usa o caminho completo (`ne-error-conditions.0.fieldName`).
  const full: FieldErrors = useMemo(() => Object.fromEntries(Object.entries(errors).map(([k, v]) => [`${p}.${k}`, v])), [errors, p])
  const category = (str(rule, 'category') || 'field') as Category
  const subtype = str(rule, 'systemSubtype') as SystemSubtype | ''
  const globals = useQuery(globalVariablesQuery()).data?.items ?? []
  const operators = operatorsFor(category, subtype || undefined, valueKind(rule, globals))
  const op = str(rule, 'operator')
  const set = (key: string, value: unknown) => onChange(setField(rule, key, value))

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Field label={t('cond.category')} path={`${p}.category`} errors={full}>
          {({ id }) => (
            <Select
              id={id}
              testId={tid('category')}
              value={category}
              options={CONDITION_CATEGORIES.map((v) => ({ value: v, label: t(`cond.categories.${v}`) }))}
              disabled={readOnly}
              onChange={(v) => onChange(defaultRule(v as Category))}
            />
          )}
        </Field>
        {category === 'system' ? (
          <Field label={t('cond.subtype')} path={`${p}.systemSubtype`} errors={full}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId={tid('subtype')}
                value={subtype}
                invalid={invalid}
                options={SYSTEM_SUBTYPES.map((v) => ({ value: v, label: t(`cond.subtypes.${v}`) }))}
                disabled={readOnly}
                onChange={(v) => onChange(systemRule(v as SystemSubtype))}
              />
            )}
          </Field>
        ) : (
          <SubjectField category={category} rule={rule} p={p} tid={tid} errors={full} readOnly={readOnly} set={set} />
        )}
      </div>
      {category === 'system' && subtype === 'message_window' ? null : (
        <Field label={t('cond.operator')} path={`${p}.operator`} errors={full}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId={tid('operator')}
              value={op}
              invalid={invalid}
              placeholder={op ? undefined : t('cond.choose')}
              options={operators.map((v) => ({ value: v, label: t(`cond.operators.${v}`), testId: `${tid('operator')}-${v}` }))}
              disabled={readOnly}
              onChange={(v) => onChange(withOperator(rule, v))}
            />
          )}
        </Field>
      )}
      <ValueField category={category} subtype={subtype} rule={rule} p={p} tid={tid} errors={full} readOnly={readOnly} set={set} onChange={onChange} />
    </div>
  )
}

interface PartProps {
  rule: Config
  p: string
  tid: (part: string) => string
  errors: FieldErrors
  readOnly: boolean
  set: (key: string, value: unknown) => void
}

/** O que é comparado: campo do contato, campo personalizado ou variável global (atendimento/atendente não têm). */
function SubjectField({ category, rule, p, tid, errors, readOnly, set }: PartProps & { category: Category }) {
  const t = useT(NS)
  const listId = useId()
  const fields = useQuery({ ...customFieldsQuery(), enabled: category === 'custom_field' })
  const globals = useQuery({ ...globalVariablesQuery(), enabled: category === 'global_variable' })
  if (category === 'attendance' || category === 'attendant') return <div />
  if (category === 'field')
    return (
      <Field label={t('cond.field')} path={`${p}.fieldName`} errors={errors}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId={tid('field')}
            value={str(rule, 'fieldName')}
            invalid={invalid}
            options={CONTACT_FIELDS.map((v) => ({ value: v, label: t(`cond.contactFields.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => set('fieldName', v)}
          />
        )}
      </Field>
    )
  const q = category === 'custom_field' ? fields : globals
  const names = category === 'custom_field' ? (fields.data?.items ?? []) : (globals.data?.items ?? []).map((g) => g.name)
  const listName = category === 'custom_field' ? 'customFields' : 'globals'
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={t(category === 'custom_field' ? 'cond.customField' : 'cond.globalVariable')} path={`${p}.fieldName`} errors={errors}>
        {({ id, invalid }) => (
          <>
            <input
              id={id}
              data-testid={tid('field')}
              list={listId}
              className={inputClass}
              aria-invalid={invalid}
              value={str(rule, 'fieldName')}
              disabled={readOnly}
              onChange={(e) => set('fieldName', e.target.value)}
            />
            <datalist id={listId}>
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <ListNotice name={listName} denied={!!q.data?.denied} empty={false} />
    </div>
  )
}

function ValueField({ category, subtype, rule, p, tid, errors, readOnly, set, onChange }: PartProps & { category: Category; subtype: string; onChange: (r: Config) => void }) {
  const t = useT(NS)
  const op = str(rule, 'operator')
  if (category === 'system') {
    switch (subtype) {
      case 'tag':
        return <TagValue rule={rule} p={p} tid={tid} errors={errors} readOnly={readOnly} set={set} onChange={onChange} />
      case 'weekday':
        return (
          <Field label={t('cond.weekday')} path={`${p}.weekday`} errors={errors}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId={tid('weekday')}
                value={str(rule, 'weekday')}
                invalid={invalid}
                options={WEEKDAYS.map((d) => ({ value: d, label: t(`weekdays.${d}`) }))}
                disabled={readOnly}
                onChange={(v) => set('weekday', v)}
              />
            )}
          </Field>
        )
      case 'time':
        return (
          <Field label={t('cond.time')} path={`${p}.time`} errors={errors} hint={op === 'equal' ? t('cond.timeEqualHint') : undefined}>
            {({ id, invalid }) => (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <Select
                  id={id}
                  testId={tid('time')}
                  value={typeof rule.time === 'number' ? String(rule.time) : ''}
                  invalid={invalid}
                  options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}h` }))}
                  disabled={readOnly}
                  onChange={(v) => set('time', intOf(v))}
                />
                <Select
                  testId={tid('minute')}
                  value={typeof rule.timeMinute === 'number' ? String(rule.timeMinute) : '0'}
                  options={Array.from({ length: 12 }, (_, m) => ({ value: String(m * 5), label: `${String(m * 5).padStart(2, '0')}min` }))}
                  disabled={readOnly || op === 'equal'}
                  onChange={(v) => set('timeMinute', intOf(v))}
                />
              </div>
            )}
          </Field>
        )
      case 'date':
        return (
          <Field label={t('cond.date')} path={`${p}.date`} errors={errors}>
            {({ id, invalid }) => (
              <input id={id} type="date" data-testid={tid('date')} className={inputClass} aria-invalid={invalid} value={str(rule, 'date')} disabled={readOnly} onChange={(e) => set('date', e.target.value)} />
            )}
          </Field>
        )
      case 'message_window':
        return <Notice testId={tid('window')}>{t('cond.windowNotice')}</Notice>
      default:
        return null
    }
  }
  if (category === 'attendance')
    return (
      <Field label={t('cond.attendance')} path={`${p}.attendanceStatus`} errors={errors}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId={tid('attendance')}
            value={str(rule, 'attendanceStatus')}
            invalid={invalid}
            options={ATTENDANCE_STATUSES.map((s) => ({ value: s, label: t(`cond.attendanceStatuses.${s}`) }))}
            disabled={readOnly}
            onChange={(v) => set('attendanceStatus', v)}
          />
        )}
      </Field>
    )
  if (category === 'attendant') return <AttendantValue rule={rule} p={p} tid={tid} errors={errors} readOnly={readOnly} set={set} />
  if (!operatorNeedsValue(op)) return null
  if (op === 'type')
    return (
      <Field label={t('cond.replyType')} path={`${p}.value`} errors={errors}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId={tid('value')}
            value={str(rule, 'value')}
            invalid={invalid}
            options={REPLY_TYPES.map((v) => ({ value: v, label: t(`cond.replyTypes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => set('value', v)}
          />
        )}
      </Field>
    )
  return (
    <VarText
      label={t('cond.value')}
      path={`${p}.value`}
      errors={errors}
      testId={tid('value')}
      value={str(rule, 'value')}
      disabled={readOnly}
      hint={isNumericOperator(op) ? t('cond.numberHint') : undefined}
      onChange={(v) => set('value', v)}
    />
  )
}

/** Etiqueta: lista da empresa (grava o nome e o id) ou um nome digitado (o motor compara sem caixa). */
function TagValue({ rule, p, tid, errors, readOnly, onChange }: PartProps & { onChange: (r: Config) => void }) {
  const t = useT(NS)
  const listId = useId()
  const q = useQuery(labelsQuery())
  const labels = q.data?.items ?? []
  const pick = (name: string) => {
    const hit = labels.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase())
    let next = setField(rule, 'tagName', name)
    next = setField(next, 'tagId', hit?.id)
    onChange(next)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={t('cond.tag')} path={`${p}.tagName`} errors={errors}>
        {({ id, invalid }) => (
          <>
            <input id={id} data-testid={tid('tag')} list={listId} className={inputClass} aria-invalid={invalid} value={str(rule, 'tagName')} disabled={readOnly} onChange={(e) => pick(e.target.value)} />
            <datalist id={listId}>
              {labels.map((l) => (
                <option key={l.id} value={l.name} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <ListNotice name="labels" denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && labels.length === 0} />
    </div>
  )
}

/** Atendente: um ou mais membros da equipe (`user_ids`). */
function AttendantValue({ rule, p, tid, errors, readOnly, set }: PartProps) {
  const t = useT(NS)
  const q = useQuery(teamQuery())
  const members = q.data?.items ?? []
  const ids = strings(rule.user_ids)
  const toggle = (id: string, on: boolean) => set('user_ids', on ? [...ids, id] : ids.filter((x) => x !== id))
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium">{t('cond.attendants')}</p>
      <ul data-testid={tid('attendants')} className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {members.map((m) => (
          <li key={m.user_id}>
            <label className="flex min-w-0 items-center gap-2 text-xs">
              <input type="checkbox" data-testid={tid(`attendant-${m.user_id}`)} className="size-4" checked={ids.includes(m.user_id)} disabled={readOnly} onChange={(e) => toggle(m.user_id, e.target.checked)} />
              <span className="truncate">{m.name || m.email}</span>
            </label>
          </li>
        ))}
      </ul>
      <ListNotice name="team" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && members.length === 0} />
      <ErrorText path={`${p}.user_ids`} error={errors[`${p}.user_ids`]} />
    </div>
  )
}
