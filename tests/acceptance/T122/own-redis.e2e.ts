// AC-T122-01 / AC-T122-03 pelo Playwright: o harness deste worktree registra o Redis efetivo no e2e-server.json e o worker dele
// recebe os message.inbound emitidos por /__e2e/wa/emit (pelo proxy da web do próprio servidor).
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

test('AC-T122-03 o e2e-server.json deste worktree registra o Redis efetivo (db, stream e origem)', async ({ request }) => {
  const mod: any = await import(pathToFileURL(`${ROOT}scripts/e2e/ports.mjs`).href)
  const info = mod.readServerInfo(ROOT)
  expect(info, 'test-results/e2e-server.json ausente').toBeTruthy()
  expect(info.redis).toBeTruthy()
  expect(['derived', 'env']).toContain(info.redis.source)
  expect(info.redis.url).toMatch(new RegExp(`/${info.redis.db}$`))
  const derived = mod.e2eRedis(ROOT, process.env)
  expect(info.redis.stream).toBe(derived.stream)
  const e2e = await request.get('/__e2e')
  expect(e2e.status()).toBe(200)
  expect((await e2e.json()).stream).toBe(info.redis.stream)
})

test('AC-T122-01 o worker do harness deste worktree recebe os 20 message.inbound emitidos (0 perdas)', async ({ request }) => {
  const seed = (await (await request.get('/__e2e')).json()).seed ?? {}
  const session = seed.session_id ?? seed.sessionId ?? seed.connections?.[0]?.session_id ?? 'sessao-t122'
  const ids: string[] = []
  for (let i = 0; i < 20; i++) {
    const res = await request.post('/__e2e/wa/emit', {
      headers: { 'x-requested-with': 'crm' },
      data: {
        event: {
          v: 1,
          type: 'message.inbound',
          session_id: session,
          at: new Date().toISOString(),
          message: { id: `t122-pw-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`, from: '5599900000001@s.whatsapp.net', from_me: false, timestamp: Date.now(), text: `pw ${i}`, type: 'conversation' },
        },
      },
    })
    expect(res.status(), await res.text()).toBe(202)
    ids.push((await res.json()).stream_id)
  }
  const lost: string[] = []
  for (const id of ids) {
    const d = await request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(id)}&wait_ms=10000`)
    const body = await d.json()
    if (!(body.acked && (body.handled ?? []).some((h: any) => h.stream_id === id))) lost.push(id)
  }
  expect(lost).toEqual([])
})
