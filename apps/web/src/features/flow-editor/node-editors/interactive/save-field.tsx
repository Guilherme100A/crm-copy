// `save_user_data` opcional (menus e Aguardar resposta; 06 §3.6): salva a resposta do lead num campo. Ligar cria a
// ação; desligar remove. Os campos personalizados da empresa aparecem como sugestão.
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { useT } from '@/i18n'
import { customFieldsQuery } from '../messaging/api'
import { Check, ErrorText, inputClass, NS, str } from '../messaging/kit'
import { defaultConfig, newAction, setField, type FieldErrors } from '../messaging/rules'
import { findAction } from '../messaging/single'

const TYPE = 'save_user_data'

export function SaveUserDataFields({
  draft,
  errors,
  readOnly,
  update,
}: {
  draft: FlowAction[]
  errors: Record<string, FieldErrors>
  readOnly: boolean
  update: (next: FlowAction[]) => void
}) {
  const t = useT(NS)
  const id = useId()
  const fields = useQuery(customFieldsQuery()).data ?? []
  const action = findAction(draft, TYPE)
  const errs = action ? errors[action.id] : undefined
  return (
    <div data-testid="ne-save" className="flex flex-col gap-1.5 rounded-md border p-2">
      <Check
        label={t('save.enabled')}
        testId="ne-save-enabled"
        checked={!!action}
        disabled={readOnly}
        onChange={(on) => update(on ? [...draft, newAction(TYPE, defaultConfig(TYPE))] : draft.filter((a) => a.type !== TYPE))}
      />
      {action ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-xs font-medium">
            {t('save.field')}
          </label>
          <input
            id={id}
            data-testid="ne-save-field"
            list={`${id}-fields`}
            className={inputClass}
            aria-invalid={!!errs?.field_name}
            value={str(action.config, 'field_name')}
            disabled={readOnly}
            onChange={(e) => update(draft.map((a) => (a.id === action.id ? { ...a, config: setField(a.config, 'field_name', e.target.value) } : a)))}
          />
          <datalist id={`${id}-fields`}>
            {fields.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <ErrorText path="field_name" error={errs?.field_name} />
        </div>
      ) : null}
    </div>
  )
}
