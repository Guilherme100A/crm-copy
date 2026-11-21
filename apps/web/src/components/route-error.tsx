import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useState } from 'react'
import { useT } from '@/i18n'
import { Button } from './ui/button'

/** Each failed match gets this boundary, leaving its parent shell mounted. */
export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter()
  const t = useT('route-error')
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  const retry = async () => {
    setRetrying(true)
    setRetryFailed(false)
    try {
      // reset() only clears the React boundary; invalidate also reruns failed loaders.
      await router.invalidate()
      reset()
    } catch {
      setRetryFailed(true)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <section data-testid="route-error" role="alert" aria-labelledby="route-error-title" className="mx-auto flex max-w-lg flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground">
      <h1 id="route-error-title" className="text-xl font-semibold">{t('title')}</h1>
      <p>{t('description')}</p>
      {retryFailed ? <p>{t('retryFailed')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void retry()} disabled={retrying}>{t(retrying ? 'retrying' : 'retry')}</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>{t('reload')}</Button>
      </div>
    </section>
  )
}
