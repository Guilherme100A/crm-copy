// Modais da chave de IA (AC-T59-04; 19 §2.5, §5.1 itens 3–5, §5.6): criar/editar com o segredo sempre mascarado
// (na edição, em branco mantém o atual: o PATCH só leva `secret` preenchido), "Testar" com latência ou erro e excluir
// com os impactos e, se a chave estiver em uso (409), a lista de agentes/fluxos e o "Excluir mesmo assim".
import { Dialog } from '@base-ui/react/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, inputClass, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AI_KEY_PROVIDERS, AI_KEYS_KEY, aiKeysApi, patchBody, type AiKeyInUse, type AiKeyProvider, type AiKeyTestResult } from './api'
import { AI_PROVIDER_LABEL, type IntegrationRecord } from './catalog'
import { AI_KEY_NAME_MAX, AI_KEY_SECRET_MAX, validateAiKeyForm, type AiKeyFormErrors } from './hub-logic'

const NS = 'integrations'
const popupCls =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none'

/** Página de chaves do provedor ("Como obter a chave", 19 §3.3). */
export const AI_KEY_HELP_URL: Record<AiKeyProvider, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/app/apikey',
  openrouter: 'https://openrouter.ai/keys',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  groq: 'https://console.groq.com/keys',
}

export function AiKeyDialog({
  record,
  provider: initialProvider,
  canTest,
  onClose,
}: {
  /** Edição quando presente. */
  record?: IntegrationRecord
  /** Pré-seleção ao Configurar pelo catálogo. */
  provider?: AiKeyProvider
  canTest: boolean
  onClose: () => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const mode = record ? 'edit' : 'create'
  const [provider, setProvider] = useState<AiKeyProvider>((record?.provider as AiKeyProvider) ?? initialProvider ?? 'openai')
  const [name, setName] = useState(record?.title ?? '')
  const [secret, setSecret] = useState('')
  const [active, setActive] = useState(record?.active ?? true)
  const [errors, setErrors] = useState<AiKeyFormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<AiKeyTestResult | null>(null)

  const submit = async () => {
    const errs = validateAiKeyForm({ name, secret }, mode)
    setErrors(errs)
    setServerError(null)
    if (errs.name || errs.secret) return
    setPending(true)
    try {
      if (record) await aiKeysApi.update(record.id, patchBody({ name, secret, active }))
      else await aiKeysApi.create({ provider, name: name.trim(), secret: secret.trim(), active })
      await qc.invalidateQueries({ queryKey: AI_KEYS_KEY })
      notify('integrations-saved', t(record ? 'toast.updated' : 'toast.created'))
      onClose()
    } catch (err) {
      setServerError(serverMessage(err) ?? t('error'))
    } finally {
      setPending(false)
    }
  }

  const runTest = async () => {
    if (!record) return
    setTesting(true)
    setTest(null)
    try {
      setTest(await aiKeysApi.test(record.id))
      void qc.invalidateQueries({ queryKey: AI_KEYS_KEY })
    } catch (err) {
      setTest({ ok: false, latency_ms: 0, error: serverMessage(err) ?? t('error') })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="ai-key-editor" data-mode={mode} className={popupCls}>
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{t(record ? 'aiKey.editTitle' : 'aiKey.newTitle')}</Dialog.Title>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
              <Field label={t('aiKey.provider')} htmlFor="ai-key-provider">
                <select
                  id="ai-key-provider"
                  data-testid="ai-key-provider"
                  value={provider}
                  disabled={mode === 'edit'}
                  onChange={(e) => setProvider(e.target.value as AiKeyProvider)}
                  className={inputClass}
                >
                  {AI_KEY_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {AI_PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('aiKey.name')} htmlFor="ai-key-name" error={errors.name ? t(`aiKey.errors.${errors.name}`) : null} errorTestId="ai-key-name-error">
                <input
                  id="ai-key-name"
                  data-testid="ai-key-name"
                  value={name}
                  maxLength={AI_KEY_NAME_MAX + 20}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('aiKey.namePlaceholder')}
                  className={inputClass}
                />
              </Field>
              <Field
                label={t('aiKey.secret')}
                htmlFor="ai-key-secret"
                error={errors.secret ? t(`aiKey.errors.${errors.secret}`) : null}
                errorTestId="ai-key-secret-error"
                hint={record ? t('aiKey.secretKeep', { hint: record.detail ?? '' }) : undefined}
              >
                <input
                  id="ai-key-secret"
                  data-testid="ai-key-secret"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={secret}
                  maxLength={AI_KEY_SECRET_MAX + 20}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={record?.detail ? record.detail : t('aiKey.secretPlaceholder')}
                  className={cn(inputClass, 'font-mono')}
                />
              </Field>
              <a
                href={AI_KEY_HELP_URL[provider]}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="ai-key-help"
                className="inline-flex items-center gap-1 self-start text-xs text-primary hover:underline"
              >
                {t('aiKey.howTo')} <ExternalLink className="size-3" aria-hidden />
              </a>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid="ai-key-active" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4" />
                {t('aiKey.active')}
              </label>

              {record && canTest ? (
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" data-testid="ai-key-test" disabled={testing} onClick={() => void runTest()}>
                      {testing ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      {t('aiKey.test')}
                    </Button>
                    <span className="text-xs text-muted-foreground">{t('aiKey.testHint')}</span>
                  </div>
                  {test ? <TestResult result={test} /> : null}
                </div>
              ) : null}
            </div>
            {serverError ? (
              <p data-testid="ai-key-error" role="alert" className="px-5 pb-2 text-sm text-destructive">
                {serverError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" data-testid="ai-key-cancel" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="submit" data-testid="ai-key-save" disabled={pending}>
                {t('save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function TestResult({ result, testid = 'ai-key-test-result' }: { result: AiKeyTestResult; testid?: string }) {
  const t = useT(NS)
  return (
    <p
      data-testid={testid}
      data-ok={result.ok ? 'true' : 'false'}
      role="status"
      className={cn('text-sm', result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}
    >
      {result.ok ? t('aiKey.testOk', { ms: result.latency_ms }) : t('aiKey.testFail', { error: result.error ?? t('error') })}
    </p>
  )
}

export function AiKeyDeleteDialog({ record, onClose }: { record: IntegrationRecord; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [inUse, setInUse] = useState<AiKeyInUse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = async (force: boolean) => {
    setPending(true)
    setError(null)
    try {
      await aiKeysApi.remove(record.id, force)
      await qc.invalidateQueries({ queryKey: AI_KEYS_KEY })
      notify('integrations-deleted', t('toast.deleted'))
      onClose()
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const d = (err.details ?? {}) as Partial<AiKeyInUse>
        setInUse({ agents: d.agents ?? [], flows: d.flows ?? [] })
      } else setError(serverMessage(err) ?? t('error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="ai-key-delete" className={cn(popupCls, 'gap-4 p-5')}>
          <Dialog.Title className="text-lg font-semibold">{t('aiKey.delete.title', { name: record.title })}</Dialog.Title>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('aiKey.delete.bullet1')}</li>
            <li>{t('aiKey.delete.bullet2')}</li>
            <li>{t('aiKey.delete.bullet3')}</li>
          </ul>
          {inUse ? (
            <div data-testid="ai-key-delete-in-use" role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">{t('aiKey.delete.inUse')}</p>
              {inUse.agents.length ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('aiKey.delete.agents')}</p>
                  <ul className="list-disc pl-5">
                    {inUse.agents.map((a) => (
                      <li key={a.id} data-testid={`ai-key-delete-agent-${a.id}`}>
                        {a.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {inUse.flows.length ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('aiKey.delete.flows')}</p>
                  <ul className="list-disc pl-5">
                    {inUse.flows.map((f) => (
                      <li key={f.id} data-testid={`ai-key-delete-flow-${f.id}`}>
                        {f.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="ai-key-delete-cancel" onClick={onClose}>
              {t('cancel')}
            </Button>
            {inUse ? (
              <Button variant="destructive" data-testid="ai-key-delete-force" disabled={pending} onClick={() => void remove(true)}>
                {t('aiKey.delete.force')}
              </Button>
            ) : (
              <Button variant="destructive" data-testid="ai-key-delete-confirm" disabled={pending} onClick={() => void remove(false)}>
                {t('aiKey.delete.confirm')}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
