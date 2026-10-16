// Página 404 (spec 18 §2.3: a referência não tem; o clone mostra uma, com link para a home do papel).
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect } from 'react'
import { homeOf } from '@/app/access'
import { useT } from '@/i18n'
import { profileQuery, sessionFrom } from '@/lib/session'
import { APP_NAME } from '@/lib/utils'
import { buttonVariants } from './ui/button'

export function NotFound() {
  const t = useT()
  const { data } = useQuery(profileQuery())
  const home = data ? homeOf(sessionFrom(data)) : '/login'
  useEffect(() => {
    document.title = `${t('notFound.title')} · ${APP_NAME}`
  }, [t])
  return (
    <section data-testid="not-found" className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <p className="text-6xl font-bold text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">{t('notFound.title')}</h1>
      <p className="text-muted-foreground">{t('notFound.description')}</p>
      <Link to={home as never} data-testid="not-found-home" className={buttonVariants()}>
        {t('notFound.home')}
      </Link>
    </section>
  )
}
