// Editor do nó Aguardar resposta (06 §3.6 `wait_for_response`): mensagem opcional antes de aguardar (`send_message`),
// prazo até 31 dias ou espera indefinida (sem a saída `timeout`) e "salvar resposta" opcional.
import type { FlowAction } from '@crm/shared/flows'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { Check, DraftStatus, NS, num, str, TimeoutFields, useActionsDraft, VarText } from '../messaging/kit'
import { defaultConfig, newAction, setField } from '../messaging/rules'
import { ensureAction, findAction } from '../messaging/single'
import { SaveUserDataFields } from './save-field'

const TYPE = 'wait_for_response'
const normalize = (l: FlowAction[]) => ensureAction(l, TYPE, () => defaultConfig(TYPE), 'end')

export function WaitResponseEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, TYPE)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const message = findAction(draft, 'send_message')
  const indefinite = c.wait_indefinitely === true

  return (
    <div data-testid="ne-wait" className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5 rounded-md border p-2">
        <Check
          label={t('wait.message')}
          testId="ne-wait-message-enabled"
          checked={!!message}
          disabled={readOnly}
          onChange={(on) => update(on ? [newAction('send_message', defaultConfig('send_message')), ...draft] : draft.filter((a) => a.type !== 'send_message'))}
        />
        {message ? (
          <VarText
            label={t('message.text')}
            path="message_text"
            errors={errors[message.id]}
            multiline
            testId="ne-wait-message"
            value={str(message.config, 'message_text')}
            disabled={readOnly}
            onChange={(v) => patchConfig(message.id, (cfg) => setField(cfg, 'message_text', v))}
          />
        ) : null}
      </div>
      <Check
        label={t('wait.indefinitely')}
        testId="ne-wait-indefinitely"
        checked={indefinite}
        disabled={readOnly}
        onChange={(on) => patchConfig(action.id, (cfg) => (on ? { ...setField(setField(cfg, 'timeout_value', undefined), 'timeout_unit', undefined), wait_indefinitely: true } : { ...setField(cfg, 'wait_indefinitely', undefined), timeout_value: 1, timeout_unit: 'days' }))}
      />
      {indefinite ? null : (
        <TimeoutFields
          value={num(c, 'timeout_value')}
          unit={str(c, 'timeout_unit')}
          errors={errs}
          min={1}
          disabled={readOnly}
          hint={t('timeout.waitHint')}
          onChange={(v, u) => patchConfig(action.id, (cfg) => setField({ ...cfg, timeout_unit: u }, 'timeout_value', v))}
        />
      )}
      <SaveUserDataFields draft={draft} errors={errors} readOnly={readOnly} update={update} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
