import { describe, expect, it, vi } from 'vitest'
import { installPreloadRecovery } from './preload-recovery'

function browser(storage = new Map<string, string>()) {
  const target = new EventTarget()
  const reload = vi.fn()
  const sessionStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
  }
  const window = Object.assign(target, { sessionStorage, location: { reload } }) as unknown as Window
  const fail = (message = 'Failed to fetch dynamically imported module: /crm/assets/flows.js') => {
    const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new Error(message) })
    target.dispatchEvent(event)
    return event
  }
  return { window, reload, sessionStorage, fail }
}

describe('Vite preload recovery', () => {
  it('reloads once across repeated errors, different chunks and a new document in the same tab', () => {
    const storage = new Map<string, string>()
    const first = browser(storage)
    installPreloadRecovery(first.window)
    expect(first.fail().defaultPrevented).toBe(false)
    first.fail()
    first.fail('another chunk')
    expect(first.reload).toHaveBeenCalledTimes(1)
    const next = browser(storage)
    installPreloadRecovery(next.window)
    expect(next.fail('new chunk URL').defaultPrevented).toBe(false)
    expect(next.reload).not.toHaveBeenCalled()
    // Prevent the installed Router 1.170.44 from adding its own per-error reload.
    expect(storage.get('tanstack_router_reload:new chunk URL')).toBe('1')
  })

  it.each(['getItem', 'setItem'] as const)('does not reload when storage %s throws', (method) => {
    const b = browser()
    b.sessionStorage[method].mockImplementation(() => { throw new Error('storage unavailable') })
    installPreloadRecovery(b.window)
    expect(b.fail().defaultPrevented).toBe(false)
    expect(b.reload).not.toHaveBeenCalled()
  })

  it('does not reload if storage silently discards the budget', () => {
    const b = browser()
    b.sessionStorage.setItem.mockImplementation(() => {})
    installPreloadRecovery(b.window)
    b.fail()
    expect(b.reload).not.toHaveBeenCalled()
  })

  it('keeps the error observable when reload throws and does not retry automatically', () => {
    const b = browser()
    b.reload.mockImplementation(() => { throw new Error('reload denied') })
    installPreloadRecovery(b.window)
    expect(b.fail().defaultPrevented).toBe(false)
    b.fail()
    expect(b.reload).toHaveBeenCalledTimes(1)
  })

  it('removes the listener on cleanup', () => {
    const b = browser()
    const dispose = installPreloadRecovery(b.window)
    dispose()
    b.fail()
    expect(b.reload).not.toHaveBeenCalled()
  })
})
