// Editor do bloco Venda aprovada (AC-T114-04; 19 §3.9; 06 §3.6): produto do catálogo (com "+ Criar novo produto…",
// que abre o `ProductDialog` da T90 e já seleciona o produto criado), valor/moeda/cliente por template com variáveis,
// emissor de NF ("Não emitir nota automaticamente") e UTMify ("Não enviar para UTMify", só integrações com token),
// título e corpo do push. Peças do kit da T57 (`../logic/kit`).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { blockProductsQuery, issuersQuery, utmifyConfiguredQuery } from '@/features/settings-payments/api'
import { ProductDialog } from '@/features/settings-products/product-dialog'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import type { NodeEditorProps } from '../registry'
import {
  DraftStatus,
  Field,
  Notice,
  OutputsSummary,
  Section,
  Select,
  smallButton,
  useActionsDraft,
  VarText,
} from '../logic/kit'
import { ensureAction, findAction, setField, str, type FieldErrors } from '../logic/rules'
import {
  APPROVED_SALE_ACTION,
  appendVariable,
  defaultApprovedSaleConfig,
  NEW_PRODUCT,
  optionalIdValue,
  PUSH_VARIABLES,
  withOptionalId,
} from './sales-rules'

const NS = 'settings-payments'
const normalize = (items: FlowAction[]) => ensureAction(items, [APPROVED_SALE_ACTION], defaultApprovedSaleConfig)

export function ApprovedSaleEditor({ nodeId, type, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const products = useQuery(blockProductsQuery())
  const issuers = useQuery(issuersQuery())
  const utmify = useQuery(utmifyConfiguredQuery())
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const canCreateProduct = !!session && hasAny(session, ['settings.products.edit'])
  const [creating, setCreating] = useState(false)
  const action = findAction(draft, [APPROVED_SALE_ACTION])
  if (!action) return null
  const cfg = action.config
  const errs: FieldErrors | undefined = errors[action.id]
  const patch = (fn: (c: typeof cfg) => typeof cfg) => patchConfig(action.id, fn)
  const text = (key: string, testId: string, opts: { multiline?: boolean; hint?: string } = {}) => (
    <VarText
      label={t(`block.sale.${key}`)}
      path={key}
      errors={errs}
      value={str(cfg, key)}
      onChange={(v) => patch((c) => setField(c, key, v))}
      disabled={readOnly}
      testId={testId}
      multiline={opts.multiline}
      hint={opts.hint}
    />
  )
  const productItems = products.data?.items ?? []
  const issuerItems = issuers.data?.items ?? []
  const utmifyItems = utmify.data?.items ?? []

  return (
    <div data-testid="ne-approved-sale" className="flex flex-col gap-2">
      <Section title={t('block.sale.sections.product')}>
        <Field label={t('block.sale.product')} path="product_public_id" errors={errs}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId="ne-sale-product"
              value={str(cfg, 'product_public_id')}
              invalid={invalid}
              placeholder={t('block.common.choose')}
              options={[
                ...productItems.map((p) => ({
                  value: p.public_id,
                  label: `${p.name} · ${p.currency}`,
                  testId: `ne-sale-product-option-${p.public_id}`,
                })),
                ...(canCreateProduct
                  ? [{ value: NEW_PRODUCT, label: t('block.sale.newProduct'), testId: 'ne-sale-product-new' }]
                  : []),
              ]}
              disabled={readOnly}
              onChange={(v) =>
                v === NEW_PRODUCT ? setCreating(true) : patch((c) => setField(c, 'product_public_id', v))
              }
            />
          )}
        </Field>
        {products.data?.denied ? (
          <Notice testId="ne-sale-products-denied" tone="warn">
            {t('block.sale.productsDenied')}
          </Notice>
        ) : products.data && productItems.length === 0 ? (
          <p data-testid="ne-sale-products-empty" className="text-[11px] text-muted-foreground">
            {t('block.sale.productsEmpty')}
          </p>
        ) : null}
        {text('amount_template', 'ne-sale-amount', { hint: t('block.sale.amountHint') })}
        {text('currency_template', 'ne-sale-currency', { hint: t('block.sale.currencyHint') })}
        {text('customer_name_template', 'ne-sale-customer', { hint: t('block.sale.customerHint') })}
      </Section>

      <Section title={t('block.sale.sections.integrations')}>
        <Field label={t('block.sale.issuer')} path="note_issuer_id" errors={errs} hint={t('block.sale.issuerHint')}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId="ne-sale-issuer"
              value={optionalIdValue(cfg, 'note_issuer_id')}
              invalid={invalid}
              placeholder={t('block.sale.noIssuer')}
              options={issuerItems.map((i) => ({
                value: i.id,
                label: i.token_configured ? i.company_name : `${i.company_name} (${t('block.common.inactive')})`,
                testId: `ne-sale-issuer-option-${i.id}`,
              }))}
              disabled={readOnly}
              onChange={(v) => patch((c) => withOptionalId(c, 'note_issuer_id', v))}
            />
          )}
        </Field>
        {issuers.data?.denied ? (
          <Notice testId="ne-sale-issuers-denied" tone="warn">
            {t('block.common.listDenied')}
          </Notice>
        ) : null}
        <Field label={t('block.sale.utmify')} path="utmify_integration_id" errors={errs}>
          {({ id, invalid }) => (
            <Select
              id={id}
              testId="ne-sale-utmify"
              value={optionalIdValue(cfg, 'utmify_integration_id')}
              invalid={invalid}
              placeholder={t('block.sale.noUtmify')}
              options={utmifyItems.map((u) => ({
                value: u.id,
                label: u.company_name,
                testId: `ne-sale-utmify-option-${u.id}`,
              }))}
              disabled={readOnly}
              onChange={(v) => patch((c) => withOptionalId(c, 'utmify_integration_id', v))}
            />
          )}
        </Field>
        {utmify.data?.denied ? (
          <Notice testId="ne-sale-utmify-denied" tone="warn">
            {t('block.common.listDenied')}
          </Notice>
        ) : null}
      </Section>

      <Section title={t('block.sale.sections.push')} testId="ne-sale-push">
        {text('push_title_template', 'ne-sale-push-title')}
        {text('push_body_template', 'ne-sale-push-body', { multiline: true })}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{t('block.sale.pushVars')}</span>
          {PUSH_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`ne-sale-push-var-${v}`}
              disabled={readOnly}
              className={`${smallButton} font-mono`}
              onClick={() =>
                patch((c) => setField(c, 'push_body_template', appendVariable(str(c, 'push_body_template'), v)))
              }
            >
              {`{${v}}`}
            </button>
          ))}
        </div>
      </Section>

      <OutputsSummary type={type} actions={draft} label={(h) => t(`block.sale.outputs.${h}`)} />
      <DraftStatus blocked={blocked} />
      {creating ? (
        <ProductDialog
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            setCreating(false)
            patch((c) => setField(c, 'product_public_id', p.public_id))
          }}
        />
      ) : null}
    </div>
  )
}
