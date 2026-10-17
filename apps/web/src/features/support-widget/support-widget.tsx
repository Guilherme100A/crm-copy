// Widget de suporte no shell (SPEC T108; 18 §9.2): `SupportWidget` (efeito: injeta/identifica/encerra), `SupportButton`
// (rodapé da sidebar e drawer) e `SupportMenuItem` (menu do usuário mobile). Import ESTÁTICO no shell.
import { Menu } from '@base-ui/react/menu'
import { useQuery } from '@tanstack/react-query'
import { LifeBuoy } from 'lucide-react'
import { useEffect } from 'react'
import { appConfigQuery } from '@/features/affiliate/api'
import { useT } from '@/i18n'
import type { Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { activeSupportProvider, SUPPORT_LINK_REL, supportModeOf, syncSupportWidget, whatsappLinkOf } from './runtime'

const NS = 'support-widget'

/** Sem UI: aplica a config de suporte à sessão (a injeção é idempotente; remontar não duplica o script). */
export function SupportWidget({ session }: { session: Session }) {
  const { data } = useQuery(appConfigQuery())
  const { email, name, personal_whatsapp } = session.user
  const { isSupport } = session
  useEffect(() => {
    syncSupportWidget(data, { email, name, personal_whatsapp }, isSupport)
  }, [data, email, name, personal_whatsapp, isSupport])
  return null
}

function useSupportAction(session: Session) {
  const { data } = useQuery(appConfigQuery())
  const mode = supportModeOf(data, session.isSupport)
  return { mode, href: mode === 'whatsapp-link' ? whatsappLinkOf(data) : null }
}

const openWidget = () => activeSupportProvider()?.open()

/** Botão "Suporte" do rodapé (sidebar recolhida ou não, e drawer). `none` → nada no DOM. */
export function SupportButton({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const t = useT(NS)
  const { mode, href } = useSupportAction(session)
  const className = cn('flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-accent', collapsed && 'justify-center px-0')
  const a11y = { 'aria-label': collapsed ? t('button') : undefined, title: collapsed ? t('button') : undefined }
  const content = (
    <>
      <LifeBuoy className="size-4" aria-hidden />
      {collapsed ? null : <span className="truncate">{t('button')}</span>}
    </>
  )
  if (mode === 'whatsapp-link' && href) {
    return (
      <a data-testid="support-button" data-provider={mode} href={href} target="_blank" rel={SUPPORT_LINK_REL} className={className} {...a11y}>
        {content}
      </a>
    )
  }
  if (mode === 'script') {
    return (
      <button type="button" data-testid="support-button" data-provider={mode} onClick={openWidget} className={className} {...a11y}>
        {content}
      </button>
    )
  }
  return null
}

const menuItemClass = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent'

/** Item "Suporte" do menu do usuário (header mobile). */
export function SupportMenuItem({ session }: { session: Session }) {
  const t = useT(NS)
  const { mode, href } = useSupportAction(session)
  if (mode === 'whatsapp-link' && href) {
    return (
      <Menu.LinkItem data-testid="support-menu-item" href={href} target="_blank" rel={SUPPORT_LINK_REL} closeOnClick className={menuItemClass}>
        <LifeBuoy className="size-4" aria-hidden /> {t('button')}
      </Menu.LinkItem>
    )
  }
  if (mode === 'script') {
    return (
      <Menu.Item data-testid="support-menu-item" onClick={openWidget} className={menuItemClass}>
        <LifeBuoy className="size-4" aria-hidden /> {t('button')}
      </Menu.Item>
    )
  }
  return null
}
