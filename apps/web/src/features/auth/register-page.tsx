// `/register` e `/cadastro` (T36; spec 01 §3.3): senhas diferentes não enviam (AC-T36-02); sucesso vai ao login com
// o e-mail preenchido. `?ref`/`?via` (indicação) vão como `referral_code`.
import { Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { APP_NAME } from '@/lib/utils'
import { authApi, fieldMessage } from './api'
import { passwordProblem, PASSWORD_MIN_LENGTH } from './password'
import { Alert, AuthLayout, Field, PasswordStrength } from './ui'

export function RegisterPage({ referral }: { referral?: string }) {
  const t = useT('auth')
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', whatsapp: '', password: '', confirmation: '' })
  const [problem, setProblem] = useState<ReturnType<typeof passwordProblem>>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    if (k === 'password' || k === 'confirmation') setProblem(null)
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    const p = passwordProblem(form.password, form.confirmation)
    setProblem(p)
    if (p) return
    setPending(true)
    setError(null)
    try {
      const email = form.email.trim()
      await authApi.register({
        name: form.name.trim(),
        email,
        personal_whatsapp: form.whatsapp.replace(/\D/g, '') || null,
        password: form.password,
        password_confirmation: form.confirmation,
        ...(referral ? { referral_code: referral } : {}),
      })
      await navigate({ to: '/login', search: { email, message: 'registered' }, replace: true })
    } catch (err) {
      setError(err instanceof HttpError && err.code === 'CONFLICT' ? t('register.emailTaken') : (fieldMessage(err) ?? t('errors.generic')))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout
      testId="register-page"
      title={t('register.title')}
      subtitle={t('register.subtitle', { appName: APP_NAME })}
      footer={
        <span className="text-muted-foreground">
          {t('register.hasAccount')}{' '}
          <Link to="/login" data-testid="register-login-link" className="font-medium text-primary underline-offset-4 hover:underline">
            {t('register.login')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} data-testid="register-form" className="flex flex-col gap-4">
        <Field label={t('fields.name')} testId="register-name" name="name" autoComplete="name" required maxLength={120} value={form.name} onChange={set('name')} />
        <Field label={t('fields.email')} testId="register-email" name="email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        <Field
          label={t('fields.whatsapp')}
          testId="register-whatsapp"
          name="personal_whatsapp"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder={t('fields.whatsappPlaceholder')}
          value={form.whatsapp}
          onChange={set('whatsapp')}
        />
        <Field
          label={t('fields.password')}
          testId="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set('password')}
          error={problem === 'tooShort' ? t('password.tooShort', { min: PASSWORD_MIN_LENGTH }) : null}
          hint={<PasswordStrength password={form.password} testId="register-password-strength" />}
        />
        <Field
          label={t('fields.passwordConfirmation')}
          testId="register-password-confirmation"
          name="password_confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={form.confirmation}
          onChange={set('confirmation')}
        />
        {problem === 'mismatch' ? <Alert testId="register-password-mismatch">{t('password.mismatch')}</Alert> : null}
        {error ? <Alert testId="register-error">{error}</Alert> : null}
        <Button type="submit" data-testid="register-submit" disabled={pending}>
          {pending ? t('register.submitting') : t('register.submit')}
        </Button>
      </form>
    </AuthLayout>
  )
}
