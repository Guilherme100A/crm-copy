// Editor do Manipulador (06 §3.6 `set_contact_custom_field`/`set_created_at`): define ou faz conta (somar, subtrair,
// multiplicar, dividir — exige número) num campo personalizado do contato (lista real de `GET /api/custom-fields`), ou
// troca a data de criação do contato ("dd/MM/aaaa HH:mm:ss", ISO ou variável).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { customFieldsQuery } from '../logic/api'
import { DraftStatus, Field, inputClass, ListNotice, NS, Select, useActionsDraft, VarText } from '../logic/kit'
import { ensureAction, findAction, setField, str, switchAction } from '../logic/rules'
import { MANIPULATOR_ACTIONS, manipulatorConfig, manipulatorValue, OPERATIONS, VALUE_TYPES, withOperation, type ManipulatorAction } from './crm-rules'

const normalize = (items: FlowAction[]) => ensureAction(items, MANIPULATOR_ACTIONS, () => manipulatorConfig('set_contact_custom_field'))

export function ManipulatorEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const listId = useId()
  const fields = useQuery(customFieldsQuery())
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, MANIPULATOR_ACTIONS)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const mode = action.type as ManipulatorAction
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const operation = (str(c, 'operation') || 'set_value') as (typeof OPERATIONS)[number]
  const names = fields.data?.items ?? []

  return (
    <div data-testid="ne-manipulator" className="flex flex-col gap-2">
      <Field label={t('manip.mode')} path="mode" errors={undefined}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-manip-mode"
            value={mode}
            options={MANIPULATOR_ACTIONS.map((v) => ({ value: v, label: t(`manip.modes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => update(switchAction(draft, action.id, v, manipulatorConfig(v as ManipulatorAction)))}
          />
        )}
      </Field>
      {mode === 'set_contact_custom_field' ? (
        <>
          <Field label={t('manip.field')} path="field_name" errors={errs}>
            {({ id, invalid }) => (
              <>
                <input id={id} data-testid="ne-manip-field" list={listId} className={inputClass} aria-invalid={invalid} value={str(c, 'field_name')} disabled={readOnly} onChange={(e) => set('field_name', e.target.value)} />
                <datalist id={listId}>
                  {names.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <ListNotice name="customFields" denied={!!fields.data?.denied} empty={false} />
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <Field label={t('manip.operation')} path="operation" errors={errs}>
              {({ id }) => (
                <Select
                  id={id}
                  testId="ne-manip-operation"
                  value={operation}
                  options={OPERATIONS.map((v) => ({ value: v, label: t(`manip.operations.${v}`) }))}
                  disabled={readOnly}
                  onChange={(v) => patchConfig(action.id, (cfg) => withOperation(cfg, v as (typeof OPERATIONS)[number]))}
                />
              )}
            </Field>
            <Field label={t('manip.valueType')} path="value_type" errors={errs}>
              {({ id, invalid }) => (
                <Select
                  id={id}
                  testId="ne-manip-value-type"
                  value={str(c, 'value_type') || 'text'}
                  invalid={invalid}
                  options={VALUE_TYPES.map((v) => ({ value: v, label: t(`manip.valueTypes.${v}`), disabled: v === 'text' && operation !== 'set_value' }))}
                  disabled={readOnly}
                  onChange={(v) => patchConfig(action.id, (cfg) => ({ ...cfg, value_type: v, value: manipulatorValue(str(cfg, 'value'), v) }))}
                />
              )}
            </Field>
          </div>
          <VarText
            label={t('manip.value')}
            path="value"
            errors={errs}
            testId="ne-manip-value"
            value={str(c, 'value')}
            disabled={readOnly}
            hint={operation === 'set_value' ? undefined : t('manip.mathHint')}
            onChange={(v) => set('value', manipulatorValue(v, c.value_type))}
          />
        </>
      ) : (
        <VarText
          label={t('manip.createdAt')}
          path="value"
          errors={errs}
          testId="ne-manip-value"
          value={str(c, 'value')}
          disabled={readOnly}
          placeholder="15/10/2026 12:00:00"
          hint={t('manip.createdAtHint')}
          onChange={(v) => patchConfig(action.id, (cfg) => ({ ...cfg, operation: 'set_value', value: v }))}
        />
      )}
      <DraftStatus blocked={blocked} />
    </div>
  )
}
