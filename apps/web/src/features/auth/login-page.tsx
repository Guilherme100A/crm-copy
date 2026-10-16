// `/login` (T36; spec 01 §2, §3.3, §5.1): e-mail e senha; erro na tela sem limpar o e-mail (AC-T36-01). Após
// entrar, aplica o idioma do perfil (AC-T36-07) e vai ao `?redirect=` seguro ou à home do papel.
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { homeOf } from '@/app/access'
import { Button } from '@/components/ui/button'
import { isLocale, useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { safeRedirect } from '@/lib/redirect'
import { profileQueryKey, sessionFrom } from '@/lib/session'
import { APP_NAME } from '@/lib/utils'
import { authApi } from './api'
import { Alert, AuthLayout, Field } from './ui'

/** Avisos vindos de outras telas (`?message=`). */
export const LOGIN_MESSAGES = ['login_required', 'registered', 'password_reset', 'invitation_login'] as const
type LoginMessage = (typeof LOGIN_MESSAGES)[number]
const isLoginMessage = (v: unknown): v is LoginMessage => typeof v === 'string' && (LOGIN_MESSAGES as readonly string[]).includes(v)

export function LoginPage({ redirect, message, email: initialEmail }: { redirect?: string; message?: string; email?: string }) {
  const t = useT('auth')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setLocale } = useI18n()
  const [email, setEmail] = useState(initialEmail ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const profile = await authApi.login(email.trim(), password)
      // Sessão nova: nada do usuário anterior fica no cache.
      queryClient.clear()
      queryClient.setQueryData(profileQueryKey, profile)
      if (isLocale(profile.user.locale)) setLocale(profile.user.locale)
      await navigate({ href: safeRedirect(redirect, homeOf(sessionFrom(profile))), replace: true })
    } catch (err) {
      setPassword('')
      setError(
        err instanceof HttpError && err.code === 'RATE_LIMIT'
          ? t('login.rateLimited')
          : err instanceof HttpError && err.status < 500
            ? t('login.invalid')
            : t('errors.generic'),
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout
      testId="login-page"
      title={t('login.title')}
      subtitle={t('login.subtitle', { appName: APP_NAME })}
      footer={
        <span className="text-muted-foreground">
          {t('login.noAccount')}{' '}
          <Link to="/register" data-testid="login-register-link" className="font-medium text-primary underline-offset-4 hover:underline">
            {t('login.createAccount')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} data-testid="login-form" className="flex flex-col gap-4">
        {isLoginMessage(message) ? (
          <Alert testId="login-message" tone={message === 'login_required' || message === 'invitation_login' ? 'info' : 'success'}>
            {t(`login.messages.${message}`)}
          </Alert>
        ) : null}
        <Field label={t('fields.email')} testId="login-email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label={t('fields.password')}
          testId="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="-mt-2 text-right text-sm">
          <Link to="/forgot-password" data-testid="login-forgot-link" className="text-primary underline-offset-4 hover:underline">
            {t('login.forgot')}
          </Link>
        </div>
        {error ? <Alert testId="login-error">{error}</Alert> : null}
        <Button type="submit" data-testid="login-submit" disabled={pending}>
          {pending ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </AuthLayout>
  )
}
