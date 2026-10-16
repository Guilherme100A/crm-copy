import { describe, expect, it } from 'vitest'
import { createMailer, MemoryMailer, SmtpMailer } from './mailer'

describe('Mailer (AC-T05-05)', () => {
  it('MemoryMailer guarda to, subject, html, text', async () => {
    const m = new MemoryMailer({ from: 'app@example.com' })
    const r = await m.send({ to: 'a@x.com', subject: 'Oi', html: '<b>oi</b>', text: 'oi' })
    expect(r.messageId).toBeTruthy()
    expect(m.messages).toHaveLength(1)
    expect(m.messages[0]).toMatchObject({
      to: 'a@x.com',
      subject: 'Oi',
      html: '<b>oi</b>',
      text: 'oi',
      from: 'app@example.com',
      messageId: r.messageId,
    })
    await m.send({ to: ['b@x.com', 'c@x.com'], subject: 'Dois', text: 't' })
    expect(m.last('c@x.com')?.subject).toBe('Dois')
    expect(m.last('a@x.com')?.subject).toBe('Oi')
    m.clear()
    expect(m.sent).toHaveLength(0)
  })

  it('rejeita mensagem sem destinatário ou sem corpo', async () => {
    const m = new MemoryMailer()
    await expect(m.send({ to: [], subject: 's', text: 't' })).rejects.toThrow()
    await expect(m.send({ to: 'a@x.com', subject: 's' })).rejects.toThrow()
  })

  it('createMailer escolhe pelo transporte', async () => {
    expect(createMailer({ transport: 'memory' })).toBeInstanceOf(MemoryMailer)
    const smtp = createMailer({ transport: 'smtp', url: 'smtp://127.0.0.1:2525' })
    expect(smtp).toBeInstanceOf(SmtpMailer)
    await smtp.close()
    expect(() => createMailer({ transport: 'smtp', url: '' })).toThrow(/SMTP_URL/)
  })
})
