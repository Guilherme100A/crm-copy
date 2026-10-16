// Peças visuais das telas públicas e do perfil (T36): layout centrado, campo rotulado, alerta e medidor de senha.
import { useEffect, type ComponentProps, type ReactNode } from 'react'
import { LanguageSelect, ThemeToggle } from '@/app/shell/controls'
import { useT } from '@/i18n'
import { APP_NAME, cn } from '@/lib/utils'
import { passwordStrength } from './password'

/** Título da aba com o nome do produto. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`
  }, [title])
}

/** Tela pública: cartão centrado, largura total no celular (sem rolagem horizontal), idioma e tema no rodapé. */
export function AuthLayout({ testId, title, subtitle, children, footer }: { testId: string; title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useDocumentTitle(title)
  return (
    <main data-testid={testId} className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="text-center text-lg font-semibold" data-testid="auth-app-name">
        {APP_NAME}
      </div>
      <div className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h1 className="text-2xl font-semibold break-words">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children}
      </div>
      {footer ? <div className="w-full max-w-sm text-center text-sm">{footer}</div> : null}
      <div className="flex w-full max-w-sm items-end justify-between gap-3">
        <LanguageSelect session={null} className="min-w-0 flex-1" />
        <div className="w-auto">
          <ThemeToggle collapsed testId="auth-theme-toggle" />
        </div>
      </div>
    </main>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'id'> & { label: string; testId: string; hint?: ReactNode; error?: string | null }

/** Campo com rótulo associado (acessível por label nos testes). */
export function Field({ label, testId, hint, error, className, ...input }: InputProps) {
  const id = `f-${testId}`
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn('h-10 w-full min-w-0 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive', className)}
        {...input}
      />
      {hint}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function Alert({ testId, tone = 'error', children }: { testId: string; tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border p-3 text-sm break-words',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'info' && 'bg-accent',
        tone === 'success' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      {children}
    </div>
  )
}

/** Medidor de 4 barras (spec 01 §3.3). */
export function PasswordStrength({ password, testId }: { password: string; testId: string }) {
  const t = useT('auth')
  const { level, label } = passwordStrength(password)
  if (!password) return null
  return (
    <div data-testid={testId} data-level={level} className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 flex-1 rounded-full bg-muted',
              i <= level && (label === 'weak' ? 'bg-destructive' : label === 'medium' ? 'bg-amber-500' : 'bg-emerald-500'),
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">{t(`strength.${label}`)}</span>
    </div>
  )
}
