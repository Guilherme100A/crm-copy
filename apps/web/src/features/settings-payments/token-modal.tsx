// Modal de integração por token (19 §3.2, §3.4, §5.1): emissor de NF Notasy (T112) e UTMify (T113). Nome da empresa
// (≥ 2) e token write-only (mascarado; na edição em branco = manter). Excluir em uso por bloco "Venda aprovada" de fluxo
// ativo → 409 com o aviso do servidor e os fluxos; "Excluir mesmo assim" envia `?force=1`.
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { IntegrationModalProps } from '@/features/integrations/catalog'
import { Field, inputClass, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { tokenApi, tokenBody, tokenKey, type TokenKind } from './api'
import { DeleteShell, FormShell, NS, SecretInput } from './modal-kit'
import {
  hasFormErrors,
  LABEL_MAX,
  pathOf,
  TOKEN_MAX,
  validateTokenForm,
  type TokenForm,
  type TokenFormErrors,
} from './rules'

export function TokenModal({ kind, action, record, onClose }: IntegrationModalProps & { kind: TokenKind }) {
  if (action === 'delete' && record)
    return <TokenDelete kind={kind} id={record.id} name={record.title} onClose={onClose} />
  return <TokenEditor kind={kind} record={action === 'edit' ? record : undefined} onClose={onClose} />
}

function TokenEditor({
  kind,
  record,
  onClose,
}: {
  kind: TokenKind
  record: IntegrationModalProps['record']
  onClose: () => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const P = kind
  const mode = record ? 'edit' : 'create'
  const [form, setForm] = useState<TokenForm>({ company_name: record?.title ?? '', integration_token: '' })
  const [errors, setErrors] = useState<TokenFormErrors>({})
  const [serverErr, setServerErr] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const fieldError = (k: keyof TokenForm) =>
    errors[k] ? t(`errors.${errors[k]}`) : serverErr && pathOf(serverErr) === k ? serverMessage(serverErr, k) : null

  const submit = async () => {
    const errs = validateTokenForm(form, mode)
    setErrors(errs)
    setServerErr(null)
    if (hasFormErrors(errs)) return
    setPending(true)
    try {
      const api = tokenApi(kind)
      if (record) await api.update(record.id, tokenBody(kind, form, false))
      else await api.create(tokenBody(kind, form, true))
      await qc.invalidateQueries({ queryKey: tokenKey(kind) })
      notify(`${kind}-saved`, t(record ? 'toast.updated' : 'toast.created'))
      onClose()
    } catch (err) {
      setServerErr(err)
    } finally {
      setPending(false)
    }
  }

  const generalError = serverErr && !pathOf(serverErr) ? (serverMessage(serverErr) ?? t('common.error')) : null

  return (
    <FormShell
      testid={P}
      mode={mode}
      title={t(`${kind}.${record ? 'editTitle' : 'newTitle'}`)}
      onClose={onClose}
      onSubmit={() => void submit()}
      pending={pending}
      error={generalError}
    >
      <Field
        label={t('token.companyName')}
        htmlFor={`${P}-company-name`}
        error={fieldError('company_name')}
        errorTestId={`${P}-company-name-error`}
      >
        <input
          id={`${P}-company-name`}
          data-testid={`${P}-company-name`}
          value={form.company_name}
          maxLength={LABEL_MAX + 20}
          aria-invalid={!!fieldError('company_name')}
          onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
          placeholder={t('token.companyPlaceholder')}
          className={inputClass}
        />
      </Field>
      <Field
        label={t('token.token')}
        htmlFor={`${P}-token`}
        error={fieldError('integration_token')}
        errorTestId={`${P}-token-error`}
        hint={record ? t('token.keep', { hint: record.detail ?? '' }) : t(`${kind}.tokenHint`)}
      >
        <SecretInput
          id={`${P}-token`}
          testid={`${P}-token`}
          value={form.integration_token}
          onChange={(v) => setForm((f) => ({ ...f, integration_token: v }))}
          placeholder={record?.detail ?? ''}
          maxLength={TOKEN_MAX}
          invalid={!!fieldError('integration_token')}
        />
      </Field>
    </FormShell>
  )
}

function TokenDelete({ kind, id, name, onClose }: { kind: TokenKind; id: string; name: string; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [inUse, setInUse] = useState<{ flows: { id: string; name: string }[]; warning: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remove = async (force: boolean) => {
    setPending(true)
    setError(null)
    try {
      await tokenApi(kind).remove(id, force)
      await qc.invalidateQueries({ queryKey: tokenKey(kind) })
      notify(`${kind}-deleted`, t('toast.deleted'))
      onClose()
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const d = (err.details ?? {}) as { flows?: { id: string; name: string }[]; warning?: string }
        setInUse({ flows: d.flows ?? [], warning: d.warning ?? err.message ?? null })
      } else setError(serverMessage(err) ?? t('common.error'))
    } finally {
      setPending(false)
    }
  }
  return (
    <DeleteShell
      testid={kind}
      title={t(`${kind}.deleteTitle`, { name })}
      body={t(`${kind}.deleteBody`)}
      flows={inUse?.flows ?? null}
      warning={inUse?.warning ?? null}
      canForce
      pending={pending}
      error={error}
      onCancel={onClose}
      onConfirm={(force) => void remove(force)}
    />
  )
}
