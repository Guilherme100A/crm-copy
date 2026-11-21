import { expect, it } from 'vitest'
import { exec, tail } from '../helpers/exec'

// Reuse the acceptance command harness; build and browser run in a separate process (T02).
// Fake API only: this suite requires no shared server, OAuth or external account.
it('T004-D01 paints welcome/flows and recovers a broken lazy chunk with a bounded reload', () => {
  const result = exec('node tests/acceptance/T004-D01/browser-recovery.mjs', {
    timeoutMs: 240_000,
    env: { NODE_ENV: 'production' },
  })
  expect(result.code, tail(result)).toBe(0)
  expect(result.stdout).toContain('T004-D01 acceptance passed')
}, 300_000)
