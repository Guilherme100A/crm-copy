// `/reset-password?token=` (T36; spec 01 §4): validando → inválido/expirado | formulário → sucesso (vai ao login
// após 2 s). Token ausente, desconhecido, usado ou vencido mostram o mesmo estado "link inválido ou expirado" (AC-T36-03).
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { authApi, fieldMessage } from './api'
import { passwordProblem, PASSWORD_MIN_LENGTH } from './password'
import { Alert, AuthLayout, Field, PasswordStrength } from './ui'

export const RESET_REDIRECT_MS = 2000

export function ResetPasswordPage({ token }: { token?: string }) {
  const t = useT('auth')
  const navigate = useNavigate()
  const check = useQuery({
    queryKey: ['auth', 'password-reset', token ?? ''],
    queryFn: () => authApi.checkReset(token!),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  })
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [problem, setProblem] = useState<ReturnType<typeof passwordProblem>>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (!done) return
    const id = setTimeout(() => void navigate({ to: '/login', search: { message: 'password_reset' }, replace: true }), RESET_REDIRECT_MS)
    return () => clearTimeout(id)
  }, [done, navigate])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending || !token) return
    const p = passwordProblem(password, confirmation)
    setProblem(p)
    if (p) return
    setPending(true)
    setError(null)
    try {
      await authApi.completeReset(token, password, confirmation)
      setDone(true)
    } catch (err) {
      // Token consumido/expirado entre a checagem e o envio.
      if (err instanceof HttpError && (err.code === 'GONE' || err.code === 'NOT_FOUND')) setGone(true)
      else setError(fieldMessage(err) ?? t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  const invalid = !token || gone || check.isError || (check.data && !check.data.valid)
  const back = (
    <Link to="/login" data-testid="reset-password-back" className="font-medium text-primary underline-offset-4 hover:underline">
      {t('forgot.back')}
    </Link>
  )

  let body
  if (done) {
    body = (
      <Alert testId="reset-password-success" tone="success">
        {t('reset.success')}
      </Alert>
    )
  } else if (invalid) {
    body = (
      <div data-testid="reset-password-invalid" className="flex flex-col gap-3">
        <Alert testId="reset-password-invalid-message">{t('reset.invalid')}</Alert>
        <Link to="/forgot-password" data-testid="reset-password-request-new" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          {t('reset.requestNew')}
        </Link>
      </div>
    )
  } else if (check.isPending) {
    body = (
      <div data-testid="reset-password-loading" className="flex flex-col gap-3" aria-busy="true">
        <div className="h-10 animate-pulse rounded-md bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
        <span className="sr-only">{t('reset.validating')}</span>
      </div>
    )
  } else {
    body = (
      <form onSubmit={submit} data-testid="reset-password-form" className="flex flex-col gap-4">
        <Field
          label={t('fields.newPassword')}
          testId="reset-password-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setProblem(null)
          }}
          error={problem === 'tooShort' ? t('password.tooShort', { min: PASSWORD_MIN_LENGTH }) : null}
          hint={<PasswordStrength password={password} testId="reset-password-strength" />}
        />
        <Field
          label={t('fields.passwordConfirmation')}
          testId="reset-password-confirmation"
          name="password_confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(e) => {
            setConfirmation(e.target.value)
            setProblem(null)
          }}
        />
        {problem === 'mismatch' ? <Alert testId="reset-password-mismatch">{t('password.mismatch')}</Alert> : null}
        {error ? <Alert testId="reset-password-error">{error}</Alert> : null}
        <Button type="submit" data-testid="reset-password-submit" disabled={pending}>
          {pending ? t('reset.submitting') : t('reset.submit')}
        </Button>
      </form>
    )
  }

  return (
    <AuthLayout testId="reset-password-page" title={t('reset.title')} footer={back}>
      {body}
    </AuthLayout>
  )
}
