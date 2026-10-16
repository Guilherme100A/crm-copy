// `/invitations/$token` (T36; spec 01 §5.15–§5.16): aberto com ou sem sessão. Sem login e com conta existente, vai
// ao login com retorno ao convite (AC-T36-05); e-mail sem conta aceita criando a conta. Aceitar torna a empresa do
// convite a ativa e leva à home; o seletor passa a listá-la.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { homeOf } from '@/app/access'
import { Button } from '@/components/ui/button'
import { switchCompany } from '@/features/company-switcher/switch'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { profileQuery, sessionFrom, type Session } from '@/lib/session'
import { authApi, fieldMessage, type PublicInvitation } from './api'
import { passwordProblem, PASSWORD_MIN_LENGTH } from './password'
import { Alert, AuthLayout, Field, PasswordStrength } from './ui'

export const invitationPath = (token: string) => `/invitations/${encodeURIComponent(token)}`

export function isExpired(inv: Pick<PublicInvitation, 'status' | 'expires_at'>, now = Date.now()): boolean {
  return inv.status === 'expired' || (inv.status === 'pending' && Date.parse(inv.expires_at) <= now)
}

export function InvitationPage({ token, session }: { token: string; session: Session | null }) {
  const t = useT('auth')
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['auth', 'invitation', token], queryFn: () => authApi.invitation(token), retry: false, staleTime: 0 })
  const inv = q.data?.invitation
  const [signup, setSignup] = useState({ name: '', password: '', confirmation: '' })
  const [problem, setProblem] = useState<ReturnType<typeof passwordProblem>>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [declined, setDeclined] = useState(false)

  const open = !!inv && inv.status === 'pending' && !isExpired(inv)
  const toLogin = () =>
    void navigate({ to: '/login', search: { redirect: invitationPath(token), message: 'invitation_login', email: inv?.email }, replace: true })

  // Sem sessão e o e-mail já tem conta: entrar primeiro, voltando ao convite.
  useEffect(() => {
    if (!session && open && inv.user_exists) toLogin()
  }, [session, open, inv?.user_exists]) // só quando o convite carrega

  const finish = async (companyId: string) => {
    await switchCompany(queryClient, router, companyId)
    const profile = await queryClient.fetchQuery(profileQuery())
    await navigate({ href: profile ? homeOf(sessionFrom(profile)) : '/login', replace: true })
  }

  const accept = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault()
    if (pending) return
    let body: { name: string; password: string; password_confirmation: string } | undefined
    if (!session) {
      const p = passwordProblem(signup.password, signup.confirmation)
      setProblem(p)
      if (p) return
      body = { name: signup.name.trim(), password: signup.password, password_confirmation: signup.confirmation }
    }
    setPending(true)
    setError(null)
    try {
      const r = await authApi.acceptInvitation(token, body)
      await finish(r.company.id)
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return toLogin()
      setError(err instanceof HttpError && err.code === 'GONE' ? t('invitation.expired') : (fieldMessage(err) ?? (err instanceof HttpError && err.status < 500 ? err.message : t('errors.generic'))))
    } finally {
      setPending(false)
    }
  }

  const decline = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await authApi.declineInvitation(token)
      setDeclined(true)
    } catch {
      setError(t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  const footer = session ? null : (
    <Link to="/login" data-testid="invitation-login-link" className="font-medium text-primary underline-offset-4 hover:underline">
      {t('forgot.back')}
    </Link>
  )

  let body
  if (q.isPending) {
    body = (
      <div data-testid="invitation-loading" className="flex flex-col gap-3" aria-busy="true">
        <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
      </div>
    )
  } else if (q.isError || !inv) {
    body = q.error instanceof HttpError && q.error.status < 500 ? (
      <Alert testId="invitation-invalid">{t('invitation.invalid')}</Alert>
    ) : (
      <div className="flex flex-col gap-3">
        <Alert testId="invitation-error">{t('errors.generic')}</Alert>
        <Button variant="outline" data-testid="invitation-retry" onClick={() => void q.refetch()}>
          {t('errors.retry')}
        </Button>
      </div>
    )
  } else if (declined || inv.status === 'declined') {
    body = (
      <Alert testId="invitation-declined" tone="info">
        {t('invitation.declined')}
      </Alert>
    )
  } else if (isExpired(inv)) {
    body = <Alert testId="invitation-expired">{t('invitation.expired')}</Alert>
  } else if (inv.status !== 'pending') {
    body = <Alert testId="invitation-invalid">{t('invitation.alreadyUsed')}</Alert>
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border p-3 text-sm">
          <p>
            {inv.invited_by ? t('invitation.invitedBy', { name: inv.invited_by.name }) : t('invitation.invited')}{' '}
            <strong data-testid="invitation-company" className="break-words">
              {inv.company.name}
            </strong>
          </p>
          <p className="mt-1 text-muted-foreground">
            {t('invitation.role', { role: t(`roles.${inv.role}`) })} · <span className="break-all">{inv.email}</span>
          </p>
        </div>
        {!session && !inv.user_exists ? (
          <form onSubmit={accept} data-testid="invitation-signup-form" className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t('invitation.signupHint')}</p>
            <Field label={t('fields.name')} testId="invitation-signup-name" autoComplete="name" required value={signup.name} onChange={(e) => setSignup((s) => ({ ...s, name: e.target.value }))} />
            <Field
              label={t('fields.password')}
              testId="invitation-signup-password"
              type="password"
              autoComplete="new-password"
              required
              value={signup.password}
              onChange={(e) => {
                setSignup((s) => ({ ...s, password: e.target.value }))
                setProblem(null)
              }}
              error={problem === 'tooShort' ? t('password.tooShort', { min: PASSWORD_MIN_LENGTH }) : null}
              hint={<PasswordStrength password={signup.password} testId="invitation-signup-strength" />}
            />
            <Field
              label={t('fields.passwordConfirmation')}
              testId="invitation-signup-confirmation"
              type="password"
              autoComplete="new-password"
              required
              value={signup.confirmation}
              onChange={(e) => {
                setSignup((s) => ({ ...s, confirmation: e.target.value }))
                setProblem(null)
              }}
            />
            {problem === 'mismatch' ? <Alert testId="invitation-password-mismatch">{t('password.mismatch')}</Alert> : null}
            {error ? <Alert testId="invitation-error">{error}</Alert> : null}
            <Button type="submit" data-testid="invitation-signup-submit" disabled={pending}>
              {t('invitation.createAndAccept')}
            </Button>
          </form>
        ) : session ? (
          <>
            {error ? <Alert testId="invitation-error">{error}</Alert> : null}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button data-testid="invitation-accept" className="sm:flex-1" disabled={pending} onClick={() => void accept()}>
                {pending ? t('invitation.accepting') : t('invitation.accept')}
              </Button>
              <Button variant="outline" data-testid="invitation-decline" className="sm:flex-1" disabled={pending} onClick={() => void decline()}>
                {t('invitation.decline')}
              </Button>
            </div>
          </>
        ) : (
          <Button data-testid="invitation-login" onClick={toLogin}>
            {t('invitation.loginToAccept')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <AuthLayout testId="invitation-page" title={t('invitation.title')} footer={footer}>
      {body}
    </AuthLayout>
  )
}
