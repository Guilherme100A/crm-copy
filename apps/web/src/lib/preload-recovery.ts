const RELOAD_KEY = 'crm:preload-reload:v1'

/** At most one automatic reload per tab session, across routes and chunk URLs. */
export function installPreloadRecovery(target: Window = window): () => void {
  const onError = (event: Event) => {
    try {
      const storage = target.sessionStorage
      const payload: unknown = (event as Event & { payload?: unknown }).payload
      // TanStack Router 1.170.44 also reloads missing lazy modules. Mark that
      // attempt as handled so it cannot add another reload after our budget ends.
      if (payload instanceof Error) storage.setItem(`tanstack_router_reload:${payload.message}`, '1')
      if (storage.getItem(RELOAD_KEY)) return
      storage.setItem(RELOAD_KEY, '1')
      // Without persistent storage we cannot guarantee the budget across reloads.
      if (storage.getItem(RELOAD_KEY) !== '1') return
      target.location.reload()
    } catch {
      // Storage denied/full or reload unavailable: let the route show recovery UI.
    }
    // Never preventDefault: the rejected import must reach the match boundary,
    // including when reloading fails or when the automatic budget is exhausted.
  }
  target.addEventListener('vite:preloadError', onError)
  return () => target.removeEventListener('vite:preloadError', onError)
}
