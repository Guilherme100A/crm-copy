// Login mínimo do shell (T23) para os guards funcionarem; a T36 (UI de autenticação) substitui esta tela.
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useActionState, useEffect } from 'react'
import { homeOf } from '@/app/access'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { api, HttpError } from '@/lib/http'
import { safeRedirect } from '@/lib/redirect'
import { profileQueryKey, sessionFrom, type Profile } from '@/lib/session'
import { APP_NAME } from '@/lib/utils'

export function LoginPage({ redirect, message }: { redirect?: string; message?: string }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  useEffect(() => {
    document.title = `${t('login.title')} · ${APP_NAME}`
  }, [t])

  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const profile = await api.post<Profile>('/api/auth/login', { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') })
      queryClient.setQueryData(profileQueryKey, profile)
      const target = safeRedirect(redirect, homeOf(sessionFrom(profile)))
      await navigate({ href: target, replace: true })
      return null
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) return t('login.rateLimited')
      return t('login.invalid')
    }
  }, null)

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form action={submit} data-testid="login-form" className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('login.subtitle', { appName: APP_NAME })}</p>
        </div>
        {message === 'login_required' ? <p className="rounded-md bg-accent p-2 text-sm">{t('login.loginRequired')}</p> : null}
        <label className="flex flex-col gap-1 text-sm">
          {t('login.email')}
          <input name="email" type="email" autoComplete="email" required className="h-9 rounded-md border bg-background px-3" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('login.password')}
          <input name="password" type="password" autoComplete="current-password" required className="h-9 rounded-md border bg-background px-3" />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </main>
  )
}
