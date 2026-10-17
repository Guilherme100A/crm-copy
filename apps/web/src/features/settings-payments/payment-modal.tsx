// Modal da chave de pagamento XPag (AC-T114-02; 19 §3.1, §5.1, §5.2): "Nova chave de pagamento"/"Atualizar chave",
// gateway fixo depois de criado, Client ID e Client Secret (mascarado; na edição em branco = manter), validações do
// servidor no campo (422 `details.fields`), "Testar conexão" só na edição e a URL do webhook (só leitura). Excluir pede
// confirmação; em uso por fluxo ativo (409) lista os fluxos. Zenith fora de escopo (SPEC 10.1 nº 13).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, PlugZap } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { IntegrationModalProps } from '@/features/integrations/catalog'
import { Field, inputClass, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { GATEWAY_LABEL, PAYMENT_GATEWAYS_UI, paymentsApi, PAYMENTS_KEY, type ConnectionTest } from './api'
import { DeleteShell, FormShell, NS, SecretInput } from './modal-kit'
import {
  CLIENT_ID_MAX,
  hasFormErrors,
  pathOf,
  LABEL_MAX,
  paymentBody,
  SECRET_MAX,
  validatePaymentForm,
  type PaymentForm,
  type PaymentFormErrors,
} from './rules'

const P = 'payment-key'
const EMPTY: PaymentForm = { label: '', client_id: '', client_secret: '' }

export default function PaymentModal({ action, item, record, onClose }: IntegrationModalProps) {
  if (action === 'delete' && record) return <PaymentDelete id={record.id} name={record.title} onClose={onClose} />
  return (
    <PaymentEditor
      id={action === 'edit' ? record?.id : undefined}
      gateway={record?.provider ?? item?.provider ?? 'xpag'}
      onClose={onClose}
    />
  )
}

function PaymentEditor({ id, gateway, onClose }: { id: string | undefined; gateway: string; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const mode = id ? 'edit' : 'create'
  const current = useQuery({
    queryKey: [...PAYMENTS_KEY, 'one', id],
    queryFn: () => paymentsApi.get(id!),
    enabled: !!id,
  })
  const dto = current.data
  // Edição: parte do registro salvo (nunca o segredo) até o usuário mexer.
  const base: PaymentForm = dto ? { label: dto.label, client_id: dto.client_id, client_secret: '' } : EMPTY
  const [edited, setEdited] = useState<PaymentForm | null>(null)
  const form = edited ?? base
  const [errors, setErrors] = useState<PaymentFormErrors>({})
  const [serverErr, setServerErr] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ConnectionTest | null>(null)

  const set = (k: keyof PaymentForm) => (v: string) => setEdited((f) => ({ ...(f ?? base), [k]: v }))
  const fieldError = (k: keyof PaymentForm) =>
    errors[k] ? t(`errors.${errors[k]}`) : serverErr && pathOf(serverErr) === k ? serverMessage(serverErr, k) : null

  const submit = async () => {
    const errs = validatePaymentForm(form, mode)
    setErrors(errs)
    setServerErr(null)
    if (hasFormErrors(errs)) return
    setPending(true)
    try {
      if (id) await paymentsApi.update(id, paymentBody(form, dto?.gateway ?? gateway, 'edit'))
      else await paymentsApi.create(paymentBody(form, gateway, 'create'))
      await qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
      notify('payments-saved', t(id ? 'toast.updated' : 'toast.created'))
      onClose()
    } catch (err) {
      setServerErr(err)
    } finally {
      setPending(false)
    }
  }

  const runTest = async () => {
    if (!id) return
    setTesting(true)
    setTest(null)
    try {
      const res = await paymentsApi.test(id)
      setTest(res)
      if (res.ok) notify('payments-test-ok', t('payment.testOk'))
      else notify('payments-test-fail', t('payment.testFail', { error: res.error ?? t('common.error') }))
      void qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
    } catch (err) {
      const error = serverMessage(err) ?? t('common.error')
      setTest({ ok: false, error })
      notify('payments-test-fail', t('payment.testFail', { error }))
    } finally {
      setTesting(false)
    }
  }

  const generalError = serverErr && !pathOf(serverErr) ? (serverMessage(serverErr) ?? t('common.error')) : null
  const shownGateway = dto?.gateway ?? gateway
  const gateways: string[] = PAYMENT_GATEWAYS_UI.includes(shownGateway as never)
    ? [...PAYMENT_GATEWAYS_UI]
    : [shownGateway, ...PAYMENT_GATEWAYS_UI]

  return (
    <FormShell
      testid={P}
      mode={mode}
      title={t(id ? 'payment.editTitle' : 'payment.newTitle')}
      onClose={onClose}
      onSubmit={() => void submit()}
      pending={pending || (!!id && !dto)}
      error={generalError}
    >
      {id && current.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('common.loading')}
        </p>
      ) : null}
      {id && current.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {serverMessage(current.error) ?? t('common.error')}
        </p>
      ) : null}
      {id && !dto ? null : (
        <>
          <Field label={t('payment.gateway')} htmlFor={`${P}-gateway`} hint={t('payment.gatewayHint')}>
            <select
              id={`${P}-gateway`}
              data-testid={`${P}-gateway`}
              value={shownGateway}
              disabled
              className={inputClass}
            >
              {gateways.map((g) => (
                <option key={g} value={g}>
                  {GATEWAY_LABEL[g] ?? g}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('payment.label')}
            htmlFor={`${P}-label`}
            error={fieldError('label')}
            errorTestId={`${P}-label-error`}
          >
            <input
              id={`${P}-label`}
              data-testid={`${P}-label`}
              value={form.label}
              maxLength={LABEL_MAX + 20}
              aria-invalid={!!fieldError('label')}
              onChange={(e) => set('label')(e.target.value)}
              placeholder={t('payment.labelPlaceholder')}
              className={inputClass}
            />
          </Field>
          <Field
            label={t('payment.clientId')}
            htmlFor={`${P}-client-id`}
            error={fieldError('client_id')}
            errorTestId={`${P}-client-id-error`}
          >
            <input
              id={`${P}-client-id`}
              data-testid={`${P}-client-id`}
              value={form.client_id}
              maxLength={CLIENT_ID_MAX + 20}
              spellCheck={false}
              aria-invalid={!!fieldError('client_id')}
              onChange={(e) => set('client_id')(e.target.value)}
              className={cn(inputClass, 'font-mono')}
            />
          </Field>
          <Field
            label={t('payment.clientSecret')}
            htmlFor={`${P}-client-secret`}
            error={fieldError('client_secret')}
            errorTestId={`${P}-client-secret-error`}
            hint={dto ? t('payment.secretKeep', { hint: dto.secret_hint ?? '' }) : t('payment.secretHint')}
          >
            <SecretInput
              id={`${P}-client-secret`}
              testid={`${P}-client-secret`}
              value={form.client_secret}
              onChange={set('client_secret')}
              placeholder={dto?.secret_hint ?? ''}
              maxLength={SECRET_MAX}
              invalid={!!fieldError('client_secret')}
            />
          </Field>
          {dto ? (
            <Field label={t('payment.webhookUrl')} htmlFor={`${P}-webhook-url`} hint={t('payment.webhookHint')}>
              <input
                id={`${P}-webhook-url`}
                data-testid={`${P}-webhook-url`}
                value={dto.webhook_url}
                readOnly
                className={cn(inputClass, 'font-mono text-xs')}
              />
            </Field>
          ) : null}
          {id ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`${P}-test`}
                  disabled={testing || !dto}
                  onClick={() => void runTest()}
                >
                  {testing ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
                  {t('payment.test')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('payment.testHint')}</span>
              </div>
              {test ? (
                <p
                  data-testid={`${P}-test-result`}
                  data-ok={test.ok ? 'true' : 'false'}
                  role="status"
                  className={cn(
                    'text-sm break-words',
                    test.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive',
                  )}
                >
                  {test.ok ? t('payment.testOk') : t('payment.testFail', { error: test.error ?? t('common.error') })}
                </p>
              ) : dto?.last_tested_at ? (
                <p
                  data-testid={`${P}-last-test`}
                  data-ok={dto.last_test_ok ? 'true' : 'false'}
                  className="text-xs text-muted-foreground"
                >
                  {t(dto.last_test_ok ? 'payment.lastTestOk' : 'payment.lastTestFail')}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </FormShell>
  )
}

function PaymentDelete({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [flows, setFlows] = useState<{ id: string; name: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setPending(true)
    setError(null)
    try {
      await paymentsApi.remove(id)
      await qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
      notify('payments-deleted', t('toast.deleted'))
      onClose()
    } catch (err) {
      if (err instanceof HttpError && err.status === 409)
        setFlows((err.details as { flows?: { id: string; name: string }[] } | undefined)?.flows ?? [])
      else setError(serverMessage(err) ?? t('common.error'))
    } finally {
      setPending(false)
    }
  }
  return (
    <DeleteShell
      testid={P}
      title={t('payment.deleteTitle', { name })}
      body={t('payment.deleteBody')}
      flows={flows}
      warning={flows ? t('payment.deleteInUse') : null}
      canForce={false}
      pending={pending}
      error={error}
      onCancel={onClose}
      onConfirm={() => void remove()}
    />
  )
}
