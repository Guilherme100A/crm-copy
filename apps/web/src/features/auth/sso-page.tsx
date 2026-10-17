// `/auth/sso` (T-integração ai-manager): o painel do ai-manager abre o CRM no iframe em `/crm/auth/sso#token=<jwt>`.
// Lê o token do hash, apaga o hash da barra/histórico, chama `POST /api/auth/sso` e entra no app como no login normal.
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { homeOf } from '@/app/access'
import { isLocale, useI18n, useT } from '@/i18n'
import { safeRedirect } from '@/lib/redirect'
import { profileQueryKey, sessionFrom } from '@/lib/session'
import { authApi } from './api'
import { exchangeOnce, readSsoHash, ssoErrorKey } from './sso'
import { Alert, AuthLayout } from './ui'

type State = { kind: 'pending' } | { kind: 'error'; message: string }

export function SsoPage() {
  const t = useT('auth')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setLocale } = useI18n()
  const [state, setState] = useState<State>({ kind: 'pending' })

  useEffect(() => {
    const { token, redirect } = readSsoHash(window.location.hash)
    // O token não fica na URL (nem no histórico) depois de lido.
    if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    if (!token) {
      setState({ kind: 'error', message: t('sso.missing') })
      return
    }
    let alive = true
    exchangeOnce(token, authApi.sso)
      .then(async (profile) => {
        if (!alive) return
        queryClient.clear()
        queryClient.setQueryData(profileQueryKey, profile)
        if (isLocale(profile.user.locale)) setLocale(profile.user.locale)
        await navigate({ href: safeRedirect(redirect, homeOf(sessionFrom(profile))), replace: true })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setState({ kind: 'error', message: t(ssoErrorKey(err)) })
      })
    return () => {
      alive = false
    }
    // Uma vez por montagem: o token é de uso único.
  }, [])

  return (
    <AuthLayout testId="sso-page" title={t('sso.title')}>
      {state.kind === 'pending' ? (
        <p data-testid="sso-pending" className="text-sm text-muted-foreground" role="status">
          {t('sso.pending')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert testId="sso-error">{state.message}</Alert>
          <p className="text-sm text-muted-foreground">{t('sso.retryHint')}</p>
          <Link to="/login" data-testid="sso-login-link" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            {t('sso.login')}
          </Link>
        </div>
      )}
    </AuthLayout>
  )
}
