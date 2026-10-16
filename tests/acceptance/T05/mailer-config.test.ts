// AC-T05-05 — Mailer (porta) com MemoryMailer; loadConfig(schema) com zod sobre process.env.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { caught, freshKit, mailerMessages, mailerSend, zodFromNodeKit } from './kit'

describe('T05 — MemoryMailer', () => {
  it('AC-T05-05 MemoryMailer guarda a mensagem enviada com to, subject, html e text', async () => {
    const kit = await freshKit()
    const mailer = new kit.MemoryMailer()
    await mailerSend(mailer, {
      to: 'ana@example.test',
      subject: 'Bem-vinda ao CRM',
      html: '<p>Olá <b>Ana</b></p>',
      text: 'Olá Ana',
    })
    const msgs = mailerMessages(mailer)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      subject: 'Bem-vinda ao CRM',
      html: '<p>Olá <b>Ana</b></p>',
      text: 'Olá Ana',
    })
    const to = msgs[0].to
    expect(Array.isArray(to) ? to : [to]).toContain('ana@example.test')
  })

  it('AC-T05-05 MemoryMailer acumula várias mensagens em ordem e não envia nada para fora', async () => {
    const kit = await freshKit()
    const mailer = new kit.MemoryMailer()
    for (let i = 1; i <= 3; i++)
      await mailerSend(mailer, { to: `u${i}@example.test`, subject: `S${i}`, html: `<i>${i}</i>`, text: `${i}` })
    const msgs = mailerMessages(mailer)
    expect(msgs.map((m) => m.subject)).toEqual(['S1', 'S2', 'S3'])
    expect(msgs.map((m) => m.text)).toEqual(['1', '2', '3'])
  })

  it('AC-T05-05 instâncias de MemoryMailer são independentes', async () => {
    const kit = await freshKit()
    const a = new kit.MemoryMailer()
    const b = new kit.MemoryMailer()
    await mailerSend(a, { to: 'x@example.test', subject: 'A', html: '<p>A</p>', text: 'A' })
    expect(mailerMessages(a)).toHaveLength(1)
    expect(mailerMessages(b)).toHaveLength(0)
  })
})

describe('T05 — loadConfig', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('AC-T05-05 loadConfig(schema) devolve os valores de process.env validados pelo schema', async () => {
    const z = await zodFromNodeKit()
    const kit = await freshKit()
    vi.stubEnv('T05_REQ_ALPHA', 'valor-alpha')
    vi.stubEnv('T05_PORT', '8123')
    const cfg = await kit.loadConfig(z.object({ T05_REQ_ALPHA: z.string().min(1), T05_PORT: z.coerce.number().int() }))
    expect(cfg.T05_REQ_ALPHA).toBe('valor-alpha')
    expect(cfg.T05_PORT).toBe(8123)
  })

  it('AC-T05-05 variável obrigatória ausente → erro listando o nome', async () => {
    const z = await zodFromNodeKit()
    const kit = await freshKit()
    vi.stubEnv('T05_MISSING_BRAVO', undefined)
    vi.stubEnv('T05_PRESENT', 'ok')
    const err = await caught(() => kit.loadConfig(z.object({ T05_PRESENT: z.string(), T05_MISSING_BRAVO: z.string() })))
    expect(err).toBeTruthy()
    expect(String((err as Error).message ?? err)).toContain('T05_MISSING_BRAVO')
  })

  it('AC-T05-05 várias obrigatórias ausentes → a mensagem lista todos os nomes', async () => {
    const z = await zodFromNodeKit()
    const kit = await freshKit()
    vi.stubEnv('T05_MISSING_ONE', undefined)
    vi.stubEnv('T05_MISSING_TWO', undefined)
    const err = await caught(() => kit.loadConfig(z.object({ T05_MISSING_ONE: z.string(), T05_MISSING_TWO: z.string() })))
    expect(err).toBeTruthy()
    const msg = String((err as Error).message ?? err)
    expect(msg).toContain('T05_MISSING_ONE')
    expect(msg).toContain('T05_MISSING_TWO')
  })
})
