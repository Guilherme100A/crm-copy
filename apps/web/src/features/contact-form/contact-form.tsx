// Formulário de contato (05 §3.1, Modal Contato `VA`): nome, telefone com seletor de país (E.164) ou LID, e-mail,
// UF (select) → cidade (texto livre, limpa ao trocar a UF), CEP com máscara, etiquetas, campos personalizados e, na
// edição, os dados do anúncio. Salvar fica desabilitado enquanto inválido; erros do servidor (422/409) vão ao campo.
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { customFieldKeysQuery, labelsQuery } from '@/features/contacts/api'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { contactFormApi } from './api'
import {
  BR_STATES,
  COUNTRIES,
  countryOf,
  flagOf,
  maskZip,
  serverFieldErrors,
  toContactBody,
  validateForm,
  withState,
  type ContactDetail,
  type ContactFormValues,
  type FieldKey,
  type FormErrors,
} from './form'

const inputClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive'

function Field({
  label,
  error,
  testId,
  children,
  htmlFor,
}: {
  label: string
  error?: string
  testId: string
  children: ReactNode
  htmlFor: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p data-testid={`${testId}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ContactForm({
  initial,
  mode,
  contactId,
  dual,
  onSaved,
  onCancel,
  onEditExisting,
}: {
  initial: ContactFormValues
  mode: 'create' | 'edit'
  contactId?: string
  /** Criação pelo fluxo de busca: "Salvar contato" + "Salvar e abrir conversa". */
  dual: boolean
  onSaved: (contact: ContactDetail, openChat: boolean) => void | Promise<unknown>
  onCancel: () => void
  onEditExisting?: (id: string) => void
}) {
  const t = useT('contact-form')
  const { locale } = useI18n()
  const uid = useId()
  const [values, setValues] = useState<ContactFormValues>(initial)
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [server, setServer] = useState<FormErrors>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [conflictId, setConflictId] = useState<string | null>(null)
  const [pending, setPending] = useState<'save' | 'open' | null>(null)
  const labelsQ = useQuery(labelsQuery())
  const labels = labelsQ.data ?? []
  const fieldKeys = useQuery(customFieldKeysQuery()).data ?? []

  const local = validateForm(values)
  const invalid = Object.keys(local).length > 0
  const countryNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' })
    } catch {
      return null
    }
  }, [locale])

  const set = (patch: Partial<ContactFormValues>, field?: FieldKey) => {
    setValues((v) => ({ ...v, ...patch }))
    if (field) {
      setTouched((s) => ({ ...s, [field]: true }))
      setServer((s) => ({ ...s, [field]: undefined }))
    }
  }
  const errorOf = (field: FieldKey) =>
    server[field] ?? (touched[field] && local[field] ? t(`errors.${local[field]}`) : undefined)

  const submit = async (openChat: boolean) => {
    if (invalid) {
      setTouched({ name: true, phone: true, email: true, zip: true })
      return
    }
    setPending(openChat ? 'open' : 'save')
    setGeneral(null)
    setConflictId(null)
    try {
      const body = toContactBody(values, mode)
      const saved =
        mode === 'edit' && contactId ? await contactFormApi.update(contactId, body) : await contactFormApi.create(body)
      await onSaved(saved, openChat)
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        const { fields, other } = serverFieldErrors(err.details)
        setServer(fields)
        setGeneral(other[0] ?? (Object.keys(fields).length ? null : err.message))
      } else if (err instanceof HttpError && err.status === 409) {
        const d = err.details as { id?: string; field?: string } | undefined
        setConflictId(d?.id && d.id !== contactId ? d.id : null)
        setServer(d?.field === 'email' ? { email: t('errors.conflictEmail') } : { phone: t('errors.conflictPhone') })
        setGeneral(t('errors.conflict'))
      } else {
        setGeneral(err instanceof HttpError && err.status === 403 ? t('errors.forbidden') : t('errors.generic'))
      }
    } finally {
      setPending(null)
    }
  }

  const id = (name: string) => `${uid}-${name}`
  const country = countryOf(values.country)

  return (
    <form
      data-testid="contact-form"
      data-mode={mode}
      className="flex min-w-0 flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit(false)
      }}
    >
      <Field label={t('fields.name')} error={errorOf('name')} testId="contact-form-name" htmlFor={id('name')}>
        <input
          id={id('name')}
          data-testid="contact-form-name"
          className={inputClass}
          value={values.name}
          aria-invalid={!!errorOf('name')}
          onChange={(e) => set({ name: e.target.value }, 'name')}
          autoComplete="off"
        />
      </Field>

      <Field label={t('fields.phone')} error={errorOf('phone')} testId="contact-form-phone" htmlFor={id('phone')}>
        <div className="flex min-w-0 gap-2">
          <select
            data-testid="contact-form-country"
            aria-label={t('fields.country')}
            className={cn(inputClass, 'w-36 shrink-0 px-2 sm:w-48')}
            value={values.country}
            onChange={(e) => set({ country: e.target.value }, 'phone')}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {flagOf(c.code)} +{c.dial} {countryNames?.of(c.code) ?? c.code}
              </option>
            ))}
          </select>
          <input
            id={id('phone')}
            data-testid="contact-form-phone"
            className={inputClass}
            inputMode="tel"
            value={values.phone}
            aria-invalid={!!errorOf('phone')}
            placeholder={country.code === 'BR' ? t('fields.phonePlaceholderBr') : t('fields.phonePlaceholder')}
            onChange={(e) => set({ phone: e.target.value }, 'phone')}
            autoComplete="off"
          />
        </div>
      </Field>

      <Field label={t('fields.email')} error={errorOf('email')} testId="contact-form-email" htmlFor={id('email')}>
        <input
          id={id('email')}
          data-testid="contact-form-email"
          type="email"
          className={inputClass}
          value={values.email}
          aria-invalid={!!errorOf('email')}
          onChange={(e) => set({ email: e.target.value }, 'email')}
          autoComplete="off"
        />
      </Field>

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[6rem_1fr_8rem]">
        <Field label={t('fields.state')} error={errorOf('state')} testId="contact-form-state" htmlFor={id('state')}>
          <select
            id={id('state')}
            data-testid="contact-form-state"
            className={cn(inputClass, 'px-2')}
            value={values.state}
            onChange={(e) => {
              setValues((v) => withState(v, e.target.value))
              setServer((s) => ({ ...s, state: undefined, city: undefined }))
            }}
          >
            <option value="">{t('fields.statePlaceholder')}</option>
            {BR_STATES.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fields.city')} error={errorOf('city')} testId="contact-form-city" htmlFor={id('city')}>
          <input
            id={id('city')}
            data-testid="contact-form-city"
            className={inputClass}
            value={values.city}
            disabled={!values.state}
            placeholder={values.state ? '' : t('fields.cityPlaceholder')}
            onChange={(e) => set({ city: e.target.value }, 'city')}
            autoComplete="off"
          />
        </Field>
        <Field label={t('fields.zip')} error={errorOf('zip')} testId="contact-form-zip" htmlFor={id('zip')}>
          <input
            id={id('zip')}
            data-testid="contact-form-zip"
            className={inputClass}
            inputMode="numeric"
            placeholder="00000-000"
            value={values.zip}
            aria-invalid={!!errorOf('zip')}
            onChange={(e) => set({ zip: maskZip(e.target.value) }, 'zip')}
            autoComplete="off"
          />
        </Field>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('fields.labels')}</legend>
        <div data-testid="contact-form-labels" className="flex flex-wrap gap-2">
          {labelsQ.isSuccess && labels.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('fields.noLabels')}</span>
          ) : null}
          {labels.map((l) => {
            const on = values.labelIds.includes(l.id)
            return (
              <button
                key={l.id}
                type="button"
                data-testid={`contact-form-label-${l.id}`}
                aria-pressed={on}
                onClick={() =>
                  set({ labelIds: on ? values.labelIds.filter((x) => x !== l.id) : [...values.labelIds, l.id] })
                }
                className={cn(
                  'inline-flex max-w-48 items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-accent',
                  on && 'border-primary bg-primary/10 font-medium',
                )}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: l.color ?? 'currentColor' }}
                  aria-hidden
                />
                <span className="truncate">{l.name}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('fields.customFields')}</legend>
        <datalist id={id('cf-keys')}>
          {fieldKeys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        {values.customFields.map((row, i) => (
          <div key={i} data-testid={`contact-form-cf-${i}`} className="flex min-w-0 gap-2">
            <input
              data-testid={`contact-form-cf-${i}-key`}
              aria-label={t('fields.cfKey')}
              placeholder={t('fields.cfKey')}
              list={id('cf-keys')}
              className={inputClass}
              value={row.key}
              onChange={(e) =>
                set(
                  { customFields: values.customFields.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) },
                  'custom_fields',
                )
              }
            />
            <input
              data-testid={`contact-form-cf-${i}-value`}
              aria-label={t('fields.cfValue')}
              placeholder={t('fields.cfValue')}
              className={inputClass}
              value={row.value}
              onChange={(e) =>
                set(
                  { customFields: values.customFields.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) },
                  'custom_fields',
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              data-testid={`contact-form-cf-${i}-remove`}
              aria-label={t('fields.cfRemove')}
              onClick={() => set({ customFields: values.customFields.filter((_, j) => j !== i) }, 'custom_fields')}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        {server.custom_fields ? <p className="text-xs text-destructive">{server.custom_fields}</p> : null}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="contact-form-cf-add"
          onClick={() => set({ customFields: [...values.customFields, { key: '', value: '' }] })}
        >
          <Plus aria-hidden /> {t('fields.cfAdd')}
        </Button>
      </fieldset>

      {mode === 'edit' ? (
        <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{t('fields.ad')}</legend>
          <Field label={t('fields.ctwaClid')} testId="contact-form-ctwa" htmlFor={id('ctwa')}>
            <input
              id={id('ctwa')}
              data-testid="contact-form-ctwa"
              className={inputClass}
              value={values.ctwaClid}
              onChange={(e) => set({ ctwaClid: e.target.value })}
            />
          </Field>
          <Field label={t('fields.sourceId')} testId="contact-form-source-id" htmlFor={id('source-id')}>
            <input
              id={id('source-id')}
              data-testid="contact-form-source-id"
              className={inputClass}
              value={values.sourceId}
              onChange={(e) => set({ sourceId: e.target.value })}
            />
          </Field>
          <Field
            label={t('fields.sourceUrl')}
            error={server.source_url}
            testId="contact-form-source-url"
            htmlFor={id('source-url')}
          >
            <input
              id={id('source-url')}
              data-testid="contact-form-source-url"
              className={inputClass}
              value={values.sourceUrl}
              onChange={(e) => set({ sourceUrl: e.target.value }, 'source_url')}
            />
          </Field>
        </fieldset>
      ) : null}

      {general ? (
        <div
          data-testid="contact-form-error"
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span className="flex-1">{general}</span>
          {conflictId && onEditExisting ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="contact-form-edit-existing"
              onClick={() => onEditExisting(conflictId)}
            >
              {t('form.editExisting')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" data-testid="contact-form-cancel" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          variant={dual ? 'outline' : 'default'}
          data-testid="contact-form-save"
          disabled={invalid || !!pending}
        >
          {pending === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {mode === 'edit' ? t('form.saveChanges') : t('form.save')}
        </Button>
        {dual ? (
          <Button
            data-testid="contact-form-save-open-chat"
            disabled={invalid || !!pending}
            onClick={() => void submit(true)}
          >
            {pending === 'open' ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('form.saveOpenChat')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
