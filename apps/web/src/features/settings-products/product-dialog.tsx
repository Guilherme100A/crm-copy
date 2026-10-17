// Modal de produto (19 §3.5, AC-T90-01): nome, moeda e a faixa de preço (mín/máx) com o valor padrão (fallback). As
// regras são as do servidor (`rules.ts`); erro 422 do servidor aparece no campo (`details.fields[].path`). Exportado
// para a T114 ("+ Criar novo produto…"): `onSaved` recebe o produto gravado.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useI18n, useT } from '@/i18n'
import { Field, FormDialog, inputClass, isFieldError, serverMessage } from '@/features/settings-quick-replies/kit'
import { PRODUCTS_KEY, productsApi, type ProductDto } from './api'
import {
  currencyCodes,
  currencyLabel,
  DEFAULT_CURRENCY,
  draftFromProduct,
  formatMoney,
  hasIssues,
  NAME_MAX,
  parseMoney,
  resolvePrice,
  toProductInput,
  validateProduct,
  type ProductDraft,
  type ProductField,
} from './rules'

const NS = 'settings-products'
export const PRODUCTS_PREFIX = 'products'
const P = PRODUCTS_PREFIX

const FIELDS: { key: keyof ProductDraft; path: ProductField; testid: string }[] = [
  { key: 'price_min', path: 'price_min_cents', testid: 'min' },
  { key: 'price_max', path: 'price_max_cents', testid: 'max' },
  { key: 'price_fallback', path: 'price_fallback_cents', testid: 'fallback' },
]

export function ProductDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: ProductDto | null
  onClose: () => void
  onSaved?: (product: ProductDto) => void
}) {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<ProductDraft>(() => draftFromProduct(initial))
  const [tried, setTried] = useState(false)
  const [simulate, setSimulate] = useState('')
  const issues = tried ? validateProduct(draft) : {}
  const codes = useMemo(() => {
    const all = currencyCodes()
    // Moeda gravada fora da lista do runtime continua selecionável.
    return draft.currency && !all.includes(draft.currency) ? [draft.currency, ...all] : all
  }, [draft.currency])
  const save = useMutation({
    mutationFn: () =>
      initial ? productsApi.update(initial.id, toProductInput(draft)) : productsApi.create(toProductInput(draft)),
    onSuccess: async (product) => {
      await qc.invalidateQueries({ queryKey: PRODUCTS_KEY })
      onSaved?.(product)
      onClose()
    },
  })
  const set = (key: keyof ProductDraft, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }))
    if (save.error) save.reset()
  }
  const errorFor = (path: ProductField): string | null => {
    if (isFieldError(save.error, path)) return serverMessage(save.error, path)
    const issue = issues[path]
    return issue ? t(`errors.${issue}`) : null
  }
  const knownField = (['name', 'currency', ...FIELDS.map((f) => f.path)] as ProductField[]).some((p) =>
    isFieldError(save.error, p),
  )
  const formError = save.error && !knownField ? (serverMessage(save.error) ?? t('errors.generic')) : null

  const sim = parseMoney(simulate)
  const valid = !hasIssues(validateProduct(draft))
  const range = valid ? toProductInput(draft) : null

  return (
    <FormDialog
      prefix={P}
      open
      title={initial ? t('editTitle') : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={formError}
      onSubmit={() => {
        setTried(true)
        if (hasIssues(validateProduct(draft))) return
        save.mutate()
      }}
    >
      <Field label={t('fields.name')} htmlFor="product-name" error={errorFor('name')} errorTestId={`${P}-name-error`}>
        <input
          id="product-name"
          data-testid={`${P}-name`}
          value={draft.name}
          maxLength={NAME_MAX}
          onChange={(e) => set('name', e.target.value)}
          className={inputClass}
          autoComplete="off"
        />
      </Field>
      <Field
        label={t('fields.currency')}
        htmlFor="product-currency"
        error={errorFor('currency')}
        errorTestId={`${P}-currency-error`}
      >
        <select
          id="product-currency"
          data-testid={`${P}-currency`}
          value={draft.currency || DEFAULT_CURRENCY}
          onChange={(e) => set('currency', e.target.value)}
          className={inputClass}
        >
          {codes.map((c) => (
            <option key={c} value={c}>
              {currencyLabel(c, locale)}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={t(`fields.${f.testid}`)}
            htmlFor={`product-${f.testid}`}
            error={errorFor(f.path)}
            errorTestId={`${P}-${f.testid}-error`}
          >
            <input
              id={`product-${f.testid}`}
              data-testid={`${P}-${f.testid}`}
              inputMode="decimal"
              placeholder="0,00"
              value={draft[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        ))}
      </div>
      <div
        data-testid={`${P}-price-help`}
        className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground"
      >
        <p>{t('help.rule')}</p>
        <label className="flex flex-wrap items-center gap-2">
          <span>{t('help.simulate')}</span>
          <input
            data-testid={`${P}-simulate`}
            inputMode="decimal"
            placeholder="0,00"
            value={simulate}
            onChange={(e) => setSimulate(e.target.value)}
            className="h-8 w-28 min-w-0 rounded-md border bg-background px-2 text-sm"
          />
        </label>
        {range && simulate.trim() ? (
          <p data-testid={`${P}-simulate-result`} data-cents={resolvePrice(range, sim)}>
            {t(sim !== null && resolvePrice(range, sim) === sim ? 'help.inRange' : 'help.outOfRange', {
              value: formatMoney(resolvePrice(range, sim), range.currency, locale),
            })}
          </p>
        ) : null}
      </div>
    </FormDialog>
  )
}
