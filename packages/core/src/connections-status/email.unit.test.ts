// T47: texto do e-mail de desconexão.
import { describe, expect, it } from 'vitest'
import { disconnectEmail } from './email'

const base = { appName: 'MeuCRM', companyName: 'Loja <A>', connectionName: 'Vendas', phoneNumber: '+5511988887777', disconnectedAt: new Date('2026-10-16T12:00:00Z') }

describe('disconnectEmail', () => {
  it('assunto e corpo com APP_NAME, conexão e número; HTML escapado', () => {
    const m = disconnectEmail({ ...base, reason: 'transient', connectionsUrl: 'https://app.test/connections' })
    expect(m.subject).toBe('MeuCRM: a conexão Vendas foi desconectada')
    expect(m.text).toContain('Vendas (+5511988887777)')
    expect(m.text).toContain('2026-10-16 12:00 UTC')
    expect(m.text).toContain('https://app.test/connections')
    expect(m.html).toContain('Loja &lt;A&gt;')
    expect(m.html).not.toContain('Loja <A>')
  })

  it('motivo por tipo de queda; nunca cita API Oficial/WABA', () => {
    const texts = (['transient', 'loggedOut', 'forbidden', null] as const).map((reason) => disconnectEmail({ ...base, reason, phoneNumber: null }))
    expect(texts[0]!.text).toMatch(/reconectar sozinho/)
    expect(texts[1]!.text).toMatch(/QR Code/)
    expect(texts[2]!.text).toMatch(/403/)
    expect(texts[3]!.text).toMatch(/foi encerrada/)
    for (const m of texts) for (const body of [m.subject, m.text, m.html]) expect(body).not.toMatch(/API Oficial|Official API|WABA|Cloud API/i)
    expect(texts[0]!.text).toContain('A conexão Vendas da empresa')
  })
})
