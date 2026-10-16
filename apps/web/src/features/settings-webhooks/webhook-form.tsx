// Formulário do webhook (09 §2): nome, conexão opcional e ativo. Em `/new` é "Salvar e continuar" (vai para a edição).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { connectionsQuery, WEBHOOKS_KEY, webhookKey, webhooksApi, type WebhookDto } from './api'
import { useWebhookPerms } from './list-page'

const field = 'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70'

export function WebhookForm({ webhook }: { webhook: WebhookDto | null }) {
  const t = useT('settings-webhooks')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const conns = useQuery(connectionsQuery())
  const { canEdit } = useWebhookPerms()
  const [name, setName] = useState(webhook?.name ?? '')
  const [connection, setConnection] = useState(webhook?.connection_id ?? '')
  const [active, setActive] = useState(webhook?.active ?? true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setName(webhook?.name ?? '')
    setConnection(webhook?.connection_id ?? '')
    setActive(webhook?.active ?? true)
  }, [webhook])

  const save = async () => {
    if (!name.trim()) {
      setError(t('form.nameRequired'))
      return
    }
    setPending(true)
    setError(null)
    try {
      const input = { name: name.trim(), connection_id: connection || null, active }
      if (webhook) {
        const updated = await webhooksApi.update(webhook.id, input)
        qc.setQueryData(webhookKey(webhook.id), updated)
        notify('webhook-saved', t('form.saved'))
      } else {
        const created = await webhooksApi.create(input)
        await navigate({ to: '/settings/inbound-webhooks/$webhookId/edit', params: { webhookId: created.id } })
      }
      void qc.invalidateQueries({ queryKey: WEBHOOKS_KEY })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      data-testid="webhook-form"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('form.name')}
          <input data-testid="webhook-form-name" className={field} value={name} maxLength={120} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('form.connection')}
          <select data-testid="webhook-form-connection" className={field} value={connection} disabled={!canEdit} onChange={(e) => setConnection(e.target.value)}>
            <option value="">{t('form.noConnection')}</option>
            {(conns.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input data-testid="webhook-form-active" type="checkbox" className="size-4" checked={active} disabled={!canEdit} onChange={(e) => setActive(e.target.checked)} />
        {t('form.active')}
      </label>
      {error ? (
        <p data-testid="webhook-form-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Link to="/settings/inbound-webhooks" className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent">
          {t('form.back')}
        </Link>
        {canEdit ? (
          <Button type="submit" data-testid="webhook-form-save" disabled={pending}>
            {webhook ? t('form.save') : t('form.saveContinue')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

export function WebhookNewPage() {
  const t = useT('settings-webhooks')
  return (
    <section data-testid="page-inbound-webhooks-new" className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('form.newTitle')}</h1>
      <WebhookForm webhook={null} />
    </section>
  )
}
