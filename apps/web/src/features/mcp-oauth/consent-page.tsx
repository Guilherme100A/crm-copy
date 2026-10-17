// Consentimento do OAuth MCP (T115; 09 §5 item 9): mostra o cliente, a credencial e a empresa a que o acesso fica
// preso (somente leitura) e devolve o usuário ao cliente com o código (aprovar) ou `access_denied` (negar).
import { useQuery } from '@tanstack/react-query'
import { Building2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { APP_NAME } from '@/lib/utils'
import { consentQuery, mcpOAuthApi, redirectHost } from './api'

export function ConsentPage({ request }: { request: string | null }) {
  const t = useT('mcp-oauth')
  const q = useQuery({ ...consentQuery(request ?? ''), enabled: !!request })
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const req = q.data?.authorization_request

  const decide = async (approve: boolean) => {
    if (!req || pending) return
    setPending(approve ? 'approve' : 'deny')
    setError(null)
    try {
      const { redirect_to } = await mcpOAuthApi.decide(req, approve)
      window.location.assign(redirect_to)
    } catch (err) {
      setError(err instanceof HttpError && err.status === 404 ? t('errors.expired') : t('errors.generic'))
      setPending(null)
    }
  }

  const failure = !request
    ? 'invalid'
    : q.isError
      ? q.error instanceof HttpError && q.error.status === 403
        ? 'forbidden'
        : q.error instanceof HttpError && q.error.status === 404
          ? 'expired'
          : 'generic'
      : null

  return (
    <main data-testid="mcp-oauth-consent" className="mx-auto flex w-full max-w-lg min-w-0 flex-col gap-4 p-4 sm:p-8">
      <header className="flex items-center gap-3">
        <ShieldCheck className="size-7 shrink-0 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">{t('title')}</h1>
      </header>

      {failure ? (
        <div
          data-testid="mcp-oauth-error"
          data-reason={failure}
          role="alert"
          className="flex flex-col gap-3 rounded-xl border bg-card p-4"
        >
          <p className="text-sm">{t(`errors.${failure}`)}</p>
          {failure === 'generic' ? (
            <Button variant="outline" className="self-start" onClick={() => void q.refetch()}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : !req ? (
        <div data-testid="mcp-oauth-loading" className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-busy>
          <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-12 w-full animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <section className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-6">
          <p className="text-sm">
            <strong data-testid="mcp-oauth-client" className="font-semibold break-words">
              {req.client.name}
            </strong>{' '}
            {t('asks', { app: APP_NAME })}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('scope.read')}</li>
            <li>{t('scope.noWrite')}</li>
          </ul>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('company.label')}</legend>
            <label
              data-testid="mcp-oauth-company"
              data-company-id={req.company.id}
              className="flex min-w-0 items-center gap-3 rounded-lg border p-3 has-[:checked]:border-primary"
            >
              <input type="radio" name="company" value={req.company.id} checked readOnly className="accent-primary" />
              <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-sm font-medium">{req.company.name}</span>
            </label>
            <p className="text-xs text-muted-foreground">{t('company.hint')}</p>
          </fieldset>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t('credential')}</dt>
            <dd data-testid="mcp-oauth-credential" className="truncate">
              {req.credential.name}
            </dd>
            <dt className="text-muted-foreground">{t('redirect')}</dt>
            <dd data-testid="mcp-oauth-redirect" className="truncate">
              {redirectHost(req.client.redirect_uri)}
            </dd>
          </dl>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              data-testid="mcp-oauth-deny"
              disabled={!!pending}
              onClick={() => void decide(false)}
            >
              {t('deny')}
            </Button>
            <Button data-testid="mcp-oauth-approve" disabled={!!pending} onClick={() => void decide(true)}>
              {pending === 'approve' ? t('approving') : t('approve')}
            </Button>
          </div>
        </section>
      )}
    </main>
  )
}
