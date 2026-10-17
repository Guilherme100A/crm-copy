// Editor do nó Pixel (T104; 06 §3.5, 11 §5.4 `send_pixel_event`): pixel da empresa (`GET /api/meta/pixels`, exige
// `facebook.pixel`; sem permissão a lista vem vazia com aviso), evento Compra/Lead, valor (obrigatório na Compra;
// aceita variável) e moeda. Saídas `success`/`failure` (e `source` dos fluxos antigos).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { pixelsQuery } from '../logic/api'
import { DraftStatus, Field, ListNotice, NS, OutputsSummary, Select, useActionsDraft, VarText } from '../logic/kit'
import { ensureAction, findAction, numberOrTemplate, optional, setField, setFields, str } from '../logic/rules'
import { CURRENCIES, defaultPixel, PIXEL_EVENTS } from './external-rules'

const TYPE = 'send_pixel_event'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], defaultPixel)

export function PixelEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const q = useQuery(pixelsQuery())
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const pixels = q.data?.items ?? []
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const currency = str(c, 'currency')

  return (
    <div data-testid="ne-pixel" className="flex flex-col gap-2">
      <Field label={t('pixel.label')} path="pixel_config_id" errors={errs}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId="ne-pixel-select"
            value={str(c, 'pixel_config_id')}
            invalid={invalid}
            placeholder={t('common.choose')}
            options={pixels.map((p) => ({ value: p.id, label: `${p.name} · ${p.masked_pixel_id}`, testId: `ne-pixel-option-${p.id}` }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => setFields(cfg, { pixel_config_id: v, pixel_config_name: pixels.find((p) => p.id === v)?.name }))}
          />
        )}
      </Field>
      <ListNotice name="pixels" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && pixels.length === 0} />
      <Field label={t('pixel.event')} path="event_type" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-pixel-event"
            value={str(c, 'event_type') || 'Lead'}
            options={PIXEL_EVENTS.map((v) => ({ value: v, label: t(`pixel.events.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => set('event_type', v)}
          />
        )}
      </Field>
      <VarText
        label={t(str(c, 'event_type') === 'Compra' ? 'pixel.valueRequired' : 'pixel.value')}
        path="item_value"
        errors={errs}
        testId="ne-pixel-value"
        value={str(c, 'item_value')}
        disabled={readOnly}
        placeholder="{venda.valor}"
        onChange={(v) => set('item_value', numberOrTemplate(v))}
      />
      <Field label={t('pixel.currency')} path="currency" errors={errs} hint={t('pixel.currencyHint')}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-pixel-currency"
            value={currency}
            placeholder={t('pixel.currencyDefault')}
            options={CURRENCIES.map((v) => ({ value: v, label: v }))}
            disabled={readOnly}
            onChange={(v) => set('currency', optional(v))}
          />
        )}
      </Field>
      {/* Revisão 3 (paridade Leona 11 §5.4): page_id opcional no nó; sobrepõe o do pixel no modo business_messaging. */}
      <VarText
        label={t('pixel.pageId')}
        path="page_id"
        errors={errs}
        testId="ne-pixel-page-id"
        value={str(c, 'page_id')}
        disabled={readOnly}
        placeholder="105222333444555"
        hint={t('pixel.pageIdHint')}
        onChange={(v) => set('page_id', optional(v))}
      />
      <VarText
        label={t('pixel.wabaId')}
        path="whatsapp_business_account_id"
        errors={errs}
        testId="ne-pixel-waba-id"
        value={str(c, 'whatsapp_business_account_id')}
        disabled={readOnly}
        hint={t('pixel.wabaIdHint')}
        onChange={(v) => set('whatsapp_business_account_id', optional(v))}
      />
      <OutputsSummary type="pixel" actions={draft} label={(h) => t(`outputs.handles.${h}`)} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
