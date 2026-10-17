// Editor do bloco Pagamento (AC-T114-03; 19 §3.8, §4.6; 06 §3.6): gateway (só XPag; Zenith fora de escopo), chave do
// gateway (lista real, auto-seleciona quando há uma só), moeda e método SÓ da matriz do gateway, valor ou "chave sem
// valor", campos do pagador condicionais por método, "escutar pagamento por" e as saídas `charge_created` /
// `payment_approved` / `error` (handle `failure`) que o canvas desenha. Peças do kit da T57 (`../logic/kit`).
import { TIME_UNITS } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { gatewayKeysQuery, GATEWAY_LABEL } from '@/features/settings-payments/api'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import {
  Check,
  DraftStatus,
  Field,
  Notice,
  NumberInput,
  OutputsSummary,
  Section,
  Select,
  useActionsDraft,
  VarText,
} from '../logic/kit'
import { ensureAction, findAction, intOf, setField, str, type FieldErrors } from '../logic/rules'
import {
  currenciesOf,
  defaultPaymentConfig,
  DOCUMENT_TYPES,
  EDITOR_GATEWAYS,
  methodsOf,
  openAmountAllowed,
  PAYMENT_ACTION,
  payerFields,
  withCurrency,
  withGateway,
  withMethod,
  withOpenAmount,
} from './payment-rules'

const NS = 'settings-payments'
const normalize = (items: Parameters<typeof ensureAction>[0]) =>
  ensureAction(items, [PAYMENT_ACTION], defaultPaymentConfig)

export function PaymentEditor({ nodeId, type, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [PAYMENT_ACTION])
  const cfg = action?.config ?? {}
  const gateway = str(cfg, 'gateway')
  const keys = useQuery({ ...gatewayKeysQuery(gateway || 'xpag'), enabled: EDITOR_GATEWAYS.includes(gateway) })
  const keyItems = keys.data?.items ?? []
  const keyId = str(cfg, 'payment_integration_id')

  // Uma chave só no gateway: já vem escolhida (19 §3.8).
  const only = keyItems.length === 1 ? keyItems[0]!.id : null
  useEffect(() => {
    if (action && only && !keyId && !readOnly)
      patchConfig(action.id, (c) => setField(c, 'payment_integration_id', only))
  }, [action, only, keyId, readOnly, patchConfig])

  if (!action) return null
  const errs: FieldErrors | undefined = errors[action.id]
  const patch = (fn: (c: typeof cfg) => typeof cfg) => patchConfig(action.id, fn)
  const currency = str(cfg, 'currency')
  const method = str(cfg, 'method')
  const open = cfg.open_amount === true
  const canOpen = openAmountAllowed(gateway, currency, method)
  const fields = payerFields(gateway, currency, method)
  const amountHint =
    method === 'OXXO'
      ? t('block.payment.hints.oxxo')
      : currency === 'COP'
        ? t('block.payment.hints.cop')
        : t('block.payment.hints.amount')

  return (
    <div
      data-testid="ne-payment"
      data-gateway={gateway}
      data-currency={currency}
      data-method={method}
      className="flex flex-col gap-2"
    >
      <Section title={t('block.payment.sections.gateway')}>
        <Field label={t('block.payment.gateway')} path="gateway" errors={errs}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId="ne-pay-gateway"
              value={gateway}
              invalid={invalid}
              options={EDITOR_GATEWAYS.map((g) => ({
                value: g,
                label: GATEWAY_LABEL[g] ?? g,
                testId: `ne-pay-gateway-option-${g}`,
              }))}
              disabled={readOnly}
              onChange={(v) => patch((c) => withGateway(c, v))}
            />
          )}
        </Field>
        <Field label={t('block.payment.key')} path="payment_integration_id" errors={errs}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId="ne-pay-key"
              value={keyId}
              invalid={invalid}
              placeholder={t('block.common.choose')}
              options={keyItems.map((k) => ({
                value: k.id,
                label: k.secret_configured ? k.label : `${k.label} (${t('block.common.inactive')})`,
                testId: `ne-pay-key-option-${k.id}`,
              }))}
              disabled={readOnly}
              onChange={(v) => patch((c) => setField(c, 'payment_integration_id', v))}
            />
          )}
        </Field>
        {keys.isPending && EDITOR_GATEWAYS.includes(gateway) ? (
          <p className="text-[11px] text-muted-foreground">{t('common.loading')}</p>
        ) : keys.data?.denied ? (
          <Notice testId="ne-pay-keys-denied" tone="warn">
            {t('block.payment.keysDenied')}
          </Notice>
        ) : keys.data && keyItems.length === 0 ? (
          <Notice testId="ne-pay-keys-empty" tone="warn">
            {t('block.payment.keysEmpty', { gateway: GATEWAY_LABEL[gateway] ?? gateway })}
          </Notice>
        ) : null}
      </Section>

      <Section title={t('block.payment.sections.charge')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('block.payment.currency')} path="currency" errors={errs}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId="ne-pay-currency"
                value={currency}
                invalid={invalid}
                options={currenciesOf(gateway).map((c) => ({
                  value: c,
                  label: c,
                  testId: `ne-pay-currency-option-${c}`,
                }))}
                disabled={readOnly}
                onChange={(v) => patch((c) => withCurrency(c, v))}
              />
            )}
          </Field>
          <Field label={t('block.payment.method')} path="method" errors={errs}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId="ne-pay-method"
                value={method}
                invalid={invalid}
                options={methodsOf(gateway, currency).map((m) => ({
                  value: m,
                  label: t(`block.payment.methods.${m}`),
                  testId: `ne-pay-method-option-${m}`,
                }))}
                disabled={readOnly}
                onChange={(v) => patch((c) => withMethod(c, v))}
              />
            )}
          </Field>
        </div>
        {canOpen ? (
          <Check
            label={t('block.payment.openAmount')}
            testId="ne-pay-open-amount"
            checked={open}
            disabled={readOnly}
            onChange={(v) => patch((c) => withOpenAmount(c, v))}
          />
        ) : (
          <Notice testId="ne-pay-open-unavailable">
            {t(currency === 'ARS' ? 'block.payment.openSoon' : 'block.payment.openRequired')}
          </Notice>
        )}
        {open && canOpen ? (
          <Notice testId="ne-pay-open-notice">{t('block.payment.openNotice')}</Notice>
        ) : (
          <VarText
            label={t('block.payment.amount')}
            path="amount"
            errors={errs}
            value={str(cfg, 'amount')}
            onChange={(v) => patch((c) => setField(c, 'amount', v))}
            disabled={readOnly}
            testId="ne-pay-amount"
            placeholder="100,00"
            hint={amountHint}
          />
        )}
      </Section>

      {fields.length ? (
        <Section title={t('block.payment.sections.payer')} testId="ne-pay-payer">
          {fields.includes('name') ? (
            <VarText
              label={t('block.payment.name')}
              path="name"
              errors={errs}
              value={str(cfg, 'name')}
              onChange={(v) => patch((c) => setField(c, 'name', v))}
              disabled={readOnly}
              testId="ne-pay-name"
            />
          ) : null}
          {fields.includes('email') ? (
            <VarText
              label={t('block.payment.email')}
              path="email"
              errors={errs}
              value={str(cfg, 'email')}
              onChange={(v) => patch((c) => setField(c, 'email', v))}
              disabled={readOnly}
              testId="ne-pay-email"
            />
          ) : null}
          {fields.includes('phone') ? (
            <VarText
              label={t('block.payment.phone')}
              path="phone"
              errors={errs}
              value={str(cfg, 'phone')}
              onChange={(v) => patch((c) => setField(c, 'phone', v))}
              disabled={readOnly}
              testId="ne-pay-phone"
              hint={currency === 'COP' ? t('block.payment.hints.copPhone') : undefined}
            />
          ) : null}
          {fields.includes('document') ? (
            <VarText
              label={t('block.payment.document')}
              path="document"
              errors={errs}
              value={str(cfg, 'document')}
              onChange={(v) => patch((c) => setField(c, 'document', v || undefined))}
              disabled={readOnly}
              testId="ne-pay-document"
              hint={t('block.common.optional')}
            />
          ) : null}
          {fields.includes('document_type') ? (
            <Field label={t('block.payment.documentType')} path="document_type" errors={errs}>
              {({ id, invalid }) => (
                <Select
                  id={id}
                  testId="ne-pay-document-type"
                  value={str(cfg, 'document_type')}
                  invalid={invalid}
                  placeholder={t('block.common.none')}
                  options={(DOCUMENT_TYPES[currency] ?? []).map((d) => ({ value: d, label: d }))}
                  disabled={readOnly}
                  onChange={(v) => patch((c) => setField(c, 'document_type', v || undefined))}
                />
              )}
            </Field>
          ) : null}
        </Section>
      ) : null}

      <Section title={t('block.payment.sections.listener')}>
        <p className="text-[11px] text-muted-foreground">{t('block.payment.listenerHint')}</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('block.payment.ttlValue')} path="listener_ttl_value" errors={errs}>
            {({ id, invalid }) => (
              <NumberInput
                id={id}
                testId="ne-pay-ttl-value"
                value={typeof cfg.listener_ttl_value === 'number' ? String(cfg.listener_ttl_value) : ''}
                min={1}
                invalid={invalid}
                disabled={readOnly}
                onChange={(raw) => patch((c) => setField(c, 'listener_ttl_value', intOf(raw)))}
              />
            )}
          </Field>
          <Field label={t('block.payment.ttlUnit')} path="listener_ttl_unit" errors={errs}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId="ne-pay-ttl-unit"
                value={str(cfg, 'listener_ttl_unit')}
                invalid={invalid}
                options={TIME_UNITS.filter((u) => u !== 'seconds').map((u) => ({
                  value: u,
                  label: t(`block.payment.units.${u}`),
                }))}
                disabled={readOnly}
                onChange={(v) => patch((c) => setField(c, 'listener_ttl_unit', v))}
              />
            )}
          </Field>
        </div>
      </Section>

      <OutputsSummary
        type={type}
        actions={draft}
        label={(h) => t(`block.payment.outputs.${h.replace(/^output:/, '')}`)}
      />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
