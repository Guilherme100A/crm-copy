// `/profile` (T36; spec 01 §3.3, §5.6–§5.7): abas Pessoal, Segurança (medidor de força) e Preferências (idioma e
// tema). O idioma é gravado no servidor (`PUT /api/auth/profile { locale }`) e vale após novo login (AC-T36-07).
import { Tabs } from '@base-ui/react/tabs'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { fieldMessage } from '@/features/auth/api'
import { passwordProblem, PASSWORD_MIN_LENGTH } from '@/features/auth/password'
import { Alert, Field, PasswordStrength, useDocumentTitle } from '@/features/auth/ui'
import { isLocale, LOCALES, useI18n, useT, type Locale } from '@/i18n'
import { api, HttpError } from '@/lib/http'
import { profileQueryKey, type Profile, type Session } from '@/lib/session'
import { currentTheme, setTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

export const PROFILE_TABS = ['personal', 'security', 'preferences'] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

type ProfileUser = Profile['user']

/** Salva no servidor e atualiza o perfil em cache (nome no menu, idioma). */
function useSaveProfile() {
  const queryClient = useQueryClient()
  const router = useRouter()
  return async (body: Record<string, unknown>): Promise<ProfileUser> => {
    const { user } = await api.put<{ user: ProfileUser }>('/api/auth/profile', body)
    queryClient.setQueryData<Profile | null>(profileQueryKey, (p) => (p ? { ...p, user: { ...p.user, ...user } } : p))
    await router.invalidate()
    return user
  }
}

function errorText(err: unknown, t: (k: string) => string): string {
  if (err instanceof HttpError) {
    const code = (err.details as { error_code?: string } | undefined)?.error_code
    if (code === 'current_password_invalid') return t('errors.currentPassword')
    if (err.code === 'CONFLICT') return t('errors.emailTaken')
    const field = fieldMessage(err)
    if (field) return field
    if (err.status < 500) return err.message
  }
  return t('errors.generic')
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function PersonalTab({ user }: { user: ProfileUser }) {
  const t = useT('profile')
  const save = useSaveProfile()
  const [form, setForm] = useState({ name: user.name, email: user.email, whatsapp: user.personal_whatsapp ?? '', current: '' })
  const [status, setStatus] = useState<'idle' | 'saved' | { error: string }>('idle')
  const [pending, setPending] = useState(false)
  const emailChanged = !sameEmail(form.email, user.email)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setStatus('idle')
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending || !form.name.trim()) return
    setPending(true)
    try {
      await save({
        name: form.name.trim(),
        personal_whatsapp: form.whatsapp.replace(/\D/g, '') || null,
        ...(emailChanged ? { email: form.email.trim(), current_password: form.current } : {}),
      })
      setForm((f) => ({ ...f, current: '' }))
      setStatus('saved')
    } catch (err) {
      setStatus({ error: errorText(err, t) })
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} data-testid="profile-personal-form" className="flex max-w-lg flex-col gap-4">
      <Field label={t('fields.name')} testId="profile-name" autoComplete="name" required maxLength={120} value={form.name} onChange={set('name')} />
      <Field label={t('fields.email')} testId="profile-email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
      {emailChanged ? (
        <Field
          label={t('fields.currentPassword')}
          testId="profile-current-password"
          type="password"
          autoComplete="current-password"
          required
          value={form.current}
          onChange={set('current')}
          hint={<p className="text-xs text-muted-foreground">{t('personal.currentPasswordHint')}</p>}
        />
      ) : null}
      <Field
        label={t('fields.whatsapp')}
        testId="profile-whatsapp"
        type="tel"
        inputMode="numeric"
        placeholder={t('fields.whatsappPlaceholder')}
        value={form.whatsapp}
        onChange={set('whatsapp')}
        hint={<p className="text-xs text-muted-foreground">{t('personal.whatsappHint')}</p>}
      />
      {status === 'saved' ? (
        <Alert testId="profile-saved" tone="success">
          {t('saved')}
        </Alert>
      ) : typeof status === 'object' ? (
        <Alert testId="profile-error">{status.error}</Alert>
      ) : null}
      <div>
        <Button type="submit" data-testid="profile-save" disabled={pending || !form.name.trim()}>
          {pending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  )
}

function SecurityTab() {
  const t = useT('profile')
  const ta = useT('auth')
  const save = useSaveProfile()
  const [form, setForm] = useState({ current: '', password: '', confirmation: '' })
  const [problem, setProblem] = useState<ReturnType<typeof passwordProblem>>(null)
  const [status, setStatus] = useState<'idle' | 'saved' | { error: string }>('idle')
  const [pending, setPending] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setProblem(null)
    setStatus('idle')
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    const p = passwordProblem(form.password, form.confirmation)
    setProblem(p)
    if (p) return
    setPending(true)
    try {
      await save({ current_password: form.current, password: form.password, password_confirmation: form.confirmation })
      setForm({ current: '', password: '', confirmation: '' })
      setStatus('saved')
    } catch (err) {
      setStatus({ error: errorText(err, t) })
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} data-testid="profile-security-form" className="flex max-w-lg flex-col gap-4">
      <Field label={t('fields.currentPassword')} testId="profile-password-current" type="password" autoComplete="current-password" required value={form.current} onChange={set('current')} />
      <Field
        label={t('fields.newPassword')}
        testId="profile-password-new"
        type="password"
        autoComplete="new-password"
        required
        value={form.password}
        onChange={set('password')}
        error={problem === 'tooShort' ? ta('password.tooShort', { min: PASSWORD_MIN_LENGTH }) : null}
        hint={<PasswordStrength password={form.password} testId="profile-password-strength" />}
      />
      <Field
        label={t('fields.passwordConfirmation')}
        testId="profile-password-confirmation"
        type="password"
        autoComplete="new-password"
        required
        value={form.confirmation}
        onChange={set('confirmation')}
      />
      {problem === 'mismatch' ? <Alert testId="profile-password-mismatch">{ta('password.mismatch')}</Alert> : null}
      {status === 'saved' ? (
        <Alert testId="profile-password-saved" tone="success">
          {t('security.saved')}
        </Alert>
      ) : typeof status === 'object' ? (
        <Alert testId="profile-password-error">{status.error}</Alert>
      ) : null}
      <div>
        <Button type="submit" data-testid="profile-password-submit" disabled={pending}>
          {pending ? t('saving') : t('security.submit')}
        </Button>
      </div>
    </form>
  )
}

const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm'

function PreferencesTab() {
  const t = useT('profile')
  const ts = useT()
  const { locale: currentLocale, setLocale } = useI18n()
  const save = useSaveProfile()
  const [locale, setLocaleChoice] = useState<Locale>(currentLocale)
  const [theme, setThemeChoice] = useState<Theme>(() => currentTheme())
  const [status, setStatus] = useState<'idle' | 'saved' | { error: string }>('idle')
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    try {
      await save({ locale })
      setLocale(locale)
      setTheme(theme)
      window.dispatchEvent(new Event('crm:theme'))
      setStatus('saved')
    } catch (err) {
      setStatus({ error: errorText(err, t) })
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} data-testid="profile-preferences-form" className="flex max-w-lg flex-col gap-4">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="profile-locale" className="font-medium">
          {t('preferences.language')}
        </label>
        <select
          id="profile-locale"
          data-testid="profile-locale"
          value={locale}
          onChange={(e) => {
            if (isLocale(e.target.value)) setLocaleChoice(e.target.value)
            setStatus('idle')
          }}
          className={selectClass}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {ts(`languages.${l}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="profile-theme" className="font-medium">
          {t('preferences.theme')}
        </label>
        <select
          id="profile-theme"
          data-testid="profile-theme"
          value={theme}
          onChange={(e) => {
            setThemeChoice(e.target.value === 'dark' ? 'dark' : 'light')
            setStatus('idle')
          }}
          className={selectClass}
        >
          <option value="light">{ts('theme.light')}</option>
          <option value="dark">{ts('theme.dark')}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t('preferences.themeHint', { shortcut: ts('theme.shortcut') })}</p>
      </div>
      {status === 'saved' ? (
        <Alert testId="profile-preferences-saved" tone="success">
          {t('saved')}
        </Alert>
      ) : typeof status === 'object' ? (
        <Alert testId="profile-preferences-error">{status.error}</Alert>
      ) : null}
      <div>
        <Button type="submit" data-testid="profile-preferences-save" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  )
}

export function ProfilePage({ session, tab }: { session: Session; tab: ProfileTab }) {
  const t = useT('profile')
  const navigate = useNavigate()
  useDocumentTitle(t('title'))
  const user = session.user

  return (
    <section data-testid="profile-page" className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="truncate text-sm text-muted-foreground">{user.email}</p>
      </div>
      <Tabs.Root value={tab} onValueChange={(v) => void navigate({ to: '/profile', search: { tab: v as ProfileTab }, replace: true })} className="flex min-w-0 flex-col gap-4">
        <Tabs.List className="flex w-full max-w-lg gap-1 overflow-x-auto rounded-lg bg-muted p-1" aria-label={t('title')}>
          {PROFILE_TABS.map((id) => (
            <Tabs.Tab
              key={id}
              value={id}
              data-testid={`profile-tab-${id}`}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm',
              )}
            >
              {t(`tabs.${id}`)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="personal" data-testid="profile-panel-personal">
          <PersonalTab key={user.id} user={user} />
        </Tabs.Panel>
        <Tabs.Panel value="security" data-testid="profile-panel-security">
          <SecurityTab />
        </Tabs.Panel>
        <Tabs.Panel value="preferences" data-testid="profile-panel-preferences">
          <PreferencesTab />
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  )
}
