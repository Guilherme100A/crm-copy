// Editor do nó Notificação (06 §3.6 `send_notification`): mensagem a um número interno (equipe), com nome, DDI,
// telefone sem DDI e a mensagem com variáveis.
import type { FlowAction } from '@crm/shared/flows'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { DraftStatus, Field, inputClass, NS, str, useActionsDraft, VarText } from './kit'
import { defaultConfig, optional, setField } from './rules'
import { ensureAction, findAction } from './single'

const TYPE = 'send_notification'
const normalize = (list: FlowAction[]) => ensureAction(list, TYPE, () => defaultConfig(TYPE))

export function NotificationEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, TYPE)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const digits = (v: string) => v.replace(/\D/g, '')

  return (
    <div data-testid="ne-notification" className="flex flex-col gap-2">
      <Field label={t('notification.name')} path="name" errors={errs}>
        {({ id, invalid }) => <input id={id} data-testid="ne-notification-name" className={inputClass} aria-invalid={invalid} value={str(c, 'name')} disabled={readOnly} onChange={(e) => set('name', e.target.value)} />}
      </Field>
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
        <Field label={t('notification.countryCode')} path="country_code" errors={errs}>
          {({ id, invalid }) => (
            <input id={id} data-testid="ne-notification-country" inputMode="numeric" maxLength={4} className={inputClass} aria-invalid={invalid} value={str(c, 'country_code')} disabled={readOnly} onChange={(e) => set('country_code', optional(digits(e.target.value)))} />
          )}
        </Field>
        <Field label={t('notification.phone')} path="phone" errors={errs} hint={t('notification.phoneHint')}>
          {({ id, invalid }) => (
            <input id={id} data-testid="ne-notification-phone" inputMode="tel" maxLength={13} className={inputClass} aria-invalid={invalid} value={str(c, 'phone')} disabled={readOnly} onChange={(e) => set('phone', digits(e.target.value))} />
          )}
        </Field>
      </div>
      <VarText label={t('notification.message')} path="message" errors={errs} multiline testId="ne-notification-message" value={str(c, 'message')} disabled={readOnly} onChange={(v) => set('message', v)} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
