// Controles do rodapé do shell: tema, idioma e menu do usuário (spec 18 §2.5 rodapé, §2.7).
import { Menu } from '@base-ui/react/menu'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LogOut, Moon, Sun, User as UserIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isLocale, LOCALES, useI18n, useT } from '@/i18n'
import { api } from '@/lib/http'
import type { Session } from '@/lib/session'
import { currentTheme, toggleTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/** Tema atual, reagindo ao atalho Ctrl/Cmd+M (evento `crm:theme`). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => currentTheme())
  useEffect(() => {
    const sync = () => setTheme(currentTheme())
    window.addEventListener('crm:theme', sync)
    return () => window.removeEventListener('crm:theme', sync)
  }, [])
  return [
    theme,
    () => {
      setTheme(toggleTheme())
      window.dispatchEvent(new Event('crm:theme'))
    },
  ]
}

export function ThemeToggle({ collapsed = false, testId = 'shell-theme-toggle' }: { collapsed?: boolean; testId?: string }) {
  const t = useT()
  const [theme, toggle] = useTheme()
  const Icon = theme === 'dark' ? Moon : Sun
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={toggle}
      aria-label={t('theme.toggle')}
      title={`${t('theme.toggle')} (${t('theme.shortcut')})`}
      className={cn('flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-accent', collapsed && 'justify-center px-0')}
    >
      <Icon className="size-4" aria-hidden />
      {collapsed ? null : (
        <span className="flex flex-1 items-center justify-between">
          {theme === 'dark' ? t('theme.dark') : t('theme.light')}
          <span className="text-xs text-muted-foreground">{t('theme.shortcut')}</span>
        </span>
      )}
    </button>
  )
}

/** Seletor de idioma (troca sem recarregar; com sessão, grava no perfil). */
export function LanguageSelect({ session, className }: { session: Session | null; className?: string }) {
  const t = useT()
  const { locale, setLocale } = useI18n()
  return (
    <label className={cn('flex flex-col gap-1 text-xs text-muted-foreground', className)}>
      <span>{t('userMenu.language')}</span>
      <select
        data-testid="shell-language-select"
        value={locale}
        onChange={(e) => {
          if (isLocale(e.target.value)) setLocale(e.target.value, { persistRemote: !!session })
        }}
        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {t(`languages.${l}`)}
          </option>
        ))}
      </select>
    </label>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

/** Menu do usuário: perfil, tema, idioma e sair (Base UI Menu). */
export function UserMenu({ session, compact = false }: { session: Session; compact?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [theme, toggle] = useTheme()

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined)
    queryClient.clear()
    await navigate({ to: '/login' as never, replace: true })
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="shell-user-menu"
        aria-label={t('userMenu.open')}
        className={cn(
          'flex items-center gap-2 rounded-md text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none',
          compact ? 'p-1' : 'w-full p-2',
        )}
      >
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {initials(session.user.name) || '?'}
        </span>
        {compact ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{session.user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{session.user.email}</span>
          </span>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup className="min-w-56 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
            <Menu.Item
              data-testid="shell-user-menu-profile"
              onClick={() => void navigate({ to: '/profile' as never })}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
            >
              <UserIcon className="size-4" aria-hidden /> {t('userMenu.profile')}
            </Menu.Item>
            <Menu.Item
              data-testid="shell-user-menu-theme"
              closeOnClick={false}
              onClick={toggle}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
            >
              {theme === 'dark' ? <Moon className="size-4" aria-hidden /> : <Sun className="size-4" aria-hidden />}
              <span className="flex-1">{theme === 'dark' ? t('theme.dark') : t('theme.light')}</span>
              <span className="text-xs text-muted-foreground">{t('theme.shortcut')}</span>
            </Menu.Item>
            <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
              <LanguageSelect session={session} />
            </div>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item
              data-testid="shell-user-menu-logout"
              onClick={() => void logout()}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-destructive outline-none data-[highlighted]:bg-accent"
            >
              <LogOut className="size-4" aria-hidden /> {t('userMenu.logout')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
