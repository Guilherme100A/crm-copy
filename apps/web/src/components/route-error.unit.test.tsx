import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { RouteError } from './route-error'

const mocks = vi.hoisted(() => ({ invalidate: vi.fn(), clicks: [] as Array<() => unknown> }))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: mocks.invalidate }) }))
vi.mock('./ui/button', () => ({
  Button: ({ onClick, children, ...props }: ComponentProps<'button'>) => {
    mocks.clicks.push(onClick as () => unknown)
    return createElement('button', props, children)
  },
}))

function render(reset = vi.fn()) {
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(RouteError, { error: new Error('private stack details'), reset }),
  ))
  return { html, reset }
}

beforeEach(() => {
  mocks.invalidate.mockReset()
  mocks.clicks.length = 0
})

describe('route fallback', () => {
  it('announces a named alert and recovery actions without exposing internal error details', () => {
    const { html } = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-labelledby="route-error-title"')
    expect(html).toContain('Não foi possível abrir esta página')
    expect(html).toContain('Tentar novamente')
    expect(html).toContain('Recarregar')
    expect(html).not.toContain('private stack details')
  })

  it('reruns loaders before resetting the boundary', async () => {
    let finish!: () => void
    mocks.invalidate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const { reset } = render()
    mocks.clicks[0]!()
    expect(mocks.invalidate).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
  })

  it('keeps the boundary when invalidation fails', async () => {
    mocks.invalidate.mockRejectedValue(new Error('offline'))
    const { reset } = render()
    mocks.clicks[0]!()
    await mocks.invalidate.mock.results[0]!.value.catch(() => {})
    expect(reset).not.toHaveBeenCalled()
  })

  it('reloads the document only when the user requests it', () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    try {
      render()
      expect(reload).not.toHaveBeenCalled()
      mocks.clicks[1]!()
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
