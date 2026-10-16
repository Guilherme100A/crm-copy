// `/forgot-password` (T36; spec 01 §3.3): resposta sempre neutra; não revela se a conta existe.
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { authApi } from './api'
import { Alert, AuthLayout, Field } from './ui'

export function ForgotPasswordPage() {
  const t = useT('auth')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await authApi.requestReset(email.trim())
      setSent(true)
    } catch (err) {
      setError(err instanceof HttpError && err.code === 'RATE_LIMIT' ? t('login.rateLimited') : t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  const back = (
    <Link to="/login" data-testid="forgot-password-back" className="font-medium text-primary underline-offset-4 hover:underline">
      {t('forgot.back')}
    </Link>
  )

  return (
    <AuthLayout testId="forgot-password-page" title={t('forgot.title')} subtitle={sent ? undefined : t('forgot.subtitle')} footer={back}>
      {sent ? (
        <Alert testId="forgot-password-sent" tone="success">
          <p className="font-medium">{t('forgot.sentTitle')}</p>
          <p>{t('forgot.sentBody')}</p>
        </Alert>
      ) : (
        <form onSubmit={submit} data-testid="forgot-password-form" className="flex flex-col gap-4">
          <Field label={t('fields.email')} testId="forgot-password-email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error ? <Alert testId="forgot-password-error">{error}</Alert> : null}
          <Button type="submit" data-testid="forgot-password-submit" disabled={pending}>
            {pending ? t('forgot.submitting') : t('forgot.submit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
