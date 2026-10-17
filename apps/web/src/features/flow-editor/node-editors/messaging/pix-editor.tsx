// Editor do nó Pix (AC-T56-02/04; 06 §3.6 `send_pix_button`): chave, tipo, recebedor e valor, com a prévia em formato
// de chat do texto que o motor envia (chave, recebedor, valor e o "copia e cola" com CRC16). No clone o Pix é texto:
// os campos do cartão oficial (`pix_body`, imagem do cabeçalho) não são oferecidos.
import type { FlowAction } from '@crm/shared/flows'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { ChatPreview, DraftStatus, Field, inputClass, Notice, NS, Select, str, useActionsDraft, VarText } from './kit'
import { defaultConfig, optional, PIX_KEY_TYPES, pixPreview, setField, type PixKeyType } from './rules'
import { ensureAction, findAction } from './single'

const TYPE = 'send_pix_button'
const normalize = (list: FlowAction[]) => ensureAction(list, TYPE, () => defaultConfig(TYPE))

export function PixEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, TYPE)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const preview = pixPreview(c)
  const amount = typeof c.amount_reais === 'number' ? String(c.amount_reais) : str(c, 'amount_reais')

  return (
    <div data-testid="ne-pix" className="flex flex-col gap-2">
      <Notice testId="ne-pix-notice">{t('pix.notice')}</Notice>
      <Field label={t('pix.type')} path="pix_type" errors={errs}>
        {({ id }) => <Select id={id} testId="ne-pix-type" value={(str(c, 'pix_type') || 'EVP') as PixKeyType} options={PIX_KEY_TYPES} label={(v) => t(`pix.types.${v}`)} disabled={readOnly} onChange={(v) => set('pix_type', v)} />}
      </Field>
      <VarText label={t('pix.key')} path="pix_key" errors={errs} testId="ne-pix-key" value={str(c, 'pix_key')} disabled={readOnly} hint={t('pix.keyHint')} onChange={(v) => set('pix_key', v)} />
      <Field label={t('pix.merchant')} path="merchant_name" errors={errs}>
        {({ id, invalid }) => <input id={id} data-testid="ne-pix-merchant" className={inputClass} maxLength={25} aria-invalid={invalid} value={str(c, 'merchant_name')} disabled={readOnly} onChange={(e) => set('merchant_name', optional(e.target.value))} />}
      </Field>
      <VarText label={t('pix.amount')} path="amount_reais" errors={errs} testId="ne-pix-amount" value={amount} disabled={readOnly} placeholder="49,90" hint={t('pix.amountHint')} onChange={(v) => set('amount_reais', optional(v))} />
      <ChatPreview messages={[{ kind: 'text', text: preview.text, code: preview.emv ?? t('pix.emvAtSend'), note: preview.emv ? null : t('pix.emvNote') }]} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
