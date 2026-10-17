// Tela do próprio usuário de suporte (`/support/access`; 16 §3.7, T32): pedir acesso temporário pelo e-mail do
// owner/admin (lookup → escolher a empresa se houver mais de uma), pedidos com reenviar/cancelar e concessões
// ativas com os fluxos da empresa. Sem SSE (sem empresa ativa): atualiza por intervalo e ao focar a aba.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RotateCw, Send, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSession } from '@/features/settings-company/ui'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  grantFlowsQuery,
  MY_KEY,
  myGrantsQuery,
  myRequestsQuery,
  supportApi,
  type SupportAccessGrantDto,
  type SupportAccountDto,
} from './api'
import { accountsOf, requestErrorKey, resolveTarget } from './support'

const NS = 'settings-support'

export function SupportAccessPage() {
  const t = useT(NS)
  const qc = useQueryClient()
  const session = useSession()
  const requests = useQuery(myRequestsQuery())
  const grants = useQuery(myGrantsQuery())
  const [email, setEmail] = useState('')
  const [accounts, setAccounts] = useState<SupportAccountDto[] | null>(null)
  const [companyId, setCompanyId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: MY_KEY })

  const submit = async () => {
    setError(null)
    const target = email.trim()
    if (!/^\S+@\S+\.\S+$/.test(target)) return setError(t('me.invalidEmail'))
    setPending(true)
    try {
      let chosen = companyId || undefined
      if (!chosen) {
        const found = await supportApi.lookup(target)
        const r = resolveTarget(found)
        if (r.kind === 'none') return setError(t('me.errors.account_not_found'))
        if (r.kind === 'choose') {
          setAccounts(found)
          return setError(t('me.chooseAccount'))
        }
        chosen = r.companyId
      }
      await supportApi.request({ email: target, company_id: chosen })
      notify('support-request-sent', t('me.sent'))
      setEmail('')
      setAccounts(null)
      setCompanyId('')
      await refresh()
    } catch (err) {
      const key = requestErrorKey(err)
      if (key === 'account_required') setAccounts(accountsOf(err))
      setError(key === 'generic' ? (err instanceof HttpError ? err.message : t('common.error')) : t(`me.errors.${key}`))
    } finally {
      setPending(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      notify('support-request-updated', ok)
    } catch (err) {
      notify('support-error', err instanceof HttpError ? err.message : t('common.error'))
    }
    await refresh()
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString()
  const myRequests = requests.data ?? []

  return (
    <section data-testid="page-support-access-real" className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('me.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('me.subtitle')}</p>
      </header>

      <form
        noValidate
        className="flex max-w-xl flex-col gap-3 rounded-xl border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('me.email')}</span>
          <input
            data-testid="support-request-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setAccounts(null)
              setCompanyId('')
            }}
            placeholder={t('me.emailPlaceholder')}
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {accounts && accounts.length > 1 ? (
          <fieldset data-testid="support-request-accounts" className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 font-medium">{t('me.account')}</legend>
            {accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="support-account"
                  data-testid={`support-request-account-${a.id}`}
                  checked={companyId === a.id}
                  onChange={() => setCompanyId(a.id)}
                />
                {a.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? (
          <p data-testid="support-request-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" data-testid="support-request-submit" disabled={pending}>
            <Send aria-hidden /> {t('me.submit')}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('me.grants')}</h2>
        {(grants.data ?? []).length === 0 ? (
          <p data-testid="support-my-grants-empty" className="text-sm text-muted-foreground">
            {t('me.noGrants')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(grants.data ?? []).map((g) => (
              <GrantItem key={g.id} grant={g} active={session?.company?.id === g.company_id} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('me.requests')}</h2>
        {myRequests.length === 0 ? (
          <p data-testid="support-requests-empty" className="text-sm text-muted-foreground">
            {t('me.noRequests')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {myRequests.map((r) => (
              <li
                key={r.id}
                data-testid={`support-requests-item-${r.id}`}
                data-status={r.status}
                className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.company_name}</div>
                  <div className="text-xs text-muted-foreground">{fmt(r.resent_at ?? r.created_at)}</div>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    r.status === 'pending' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-muted',
                  )}
                >
                  {t(`me.status.${r.status}`)}
                </span>
                {r.status === 'pending' ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`support-requests-resend-${r.id}`}
                      onClick={() => void act(() => supportApi.resend(r.id), t('me.resent'))}
                    >
                      <RotateCw aria-hidden /> {t('me.resend')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      data-testid={`support-requests-cancel-${r.id}`}
                      onClick={() => void act(() => supportApi.cancel(r.id), t('me.cancelled'))}
                    >
                      <X aria-hidden /> {t('me.cancel')}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}

function GrantItem({ grant, active }: { grant: SupportAccessGrantDto; active: boolean }) {
  const t = useT(NS)
  const [open, setOpen] = useState(false)
  const flows = useQuery({ ...grantFlowsQuery(grant.company_id), enabled: open })
  return (
    <li data-testid={`support-my-grants-item-${grant.company_id}`} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{grant.company_name}</div>
          <div className="text-xs text-muted-foreground">{t('me.expiresAt', { at: new Date(grant.expires_at).toLocaleString() })}</div>
        </div>
        <Button variant="outline" size="sm" data-testid={`support-my-grants-flows-${grant.company_id}`} onClick={() => setOpen((o) => !o)}>
          {t('me.flows')}
        </Button>
        {active ? (
          <Link to={'/flows' as never} data-testid={`support-my-grants-open-${grant.company_id}`} className="text-sm text-primary underline-offset-4 hover:underline">
            {t('me.openFlows')}
          </Link>
        ) : null}
      </div>
      {open ? (
        flows.isPending ? (
          <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : (flows.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('me.noFlows')}</p>
        ) : (
          <ul className="flex flex-col gap-1 border-t pt-2">
            {(flows.data ?? []).map((f) => (
              <li key={f.id} data-testid={`support-grant-flow-${f.id}`} className="flex items-center gap-2 text-xs">
                <span className="flex-1">{f.name}</span>
                <span className="text-muted-foreground">{f.status}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  )
}
