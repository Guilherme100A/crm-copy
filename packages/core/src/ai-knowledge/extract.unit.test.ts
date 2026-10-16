import { describe, expect, it } from 'vitest'
import { chunkText, extractPdfPages, htmlTitle, htmlToText, isPdfHeader, sameHostLinks } from './extract'
import { buildPdf } from './testing/pdf'

describe('PDF (unpdf)', () => {
  it('extrai o texto por página e conta as páginas', async () => {
    const r = await extractPdfPages(buildPdf(['Olá, mundo\nPreço R$ 10', 'Segunda página']))
    expect(r.totalPages).toBe(2)
    expect(r.pages).toEqual(['Olá, mundo\nPreço R$ 10', 'Segunda página'])
  })

  it('mapeia os erros para os códigos de 07 §3.4', async () => {
    await expect(extractPdfPages(buildPdf(['']))).rejects.toMatchObject({ code: 'empty_pdf' })
    await expect(extractPdfPages(buildPdf(['segredo'], { encrypted: true }))).rejects.toMatchObject({ code: 'encrypted_pdf' })
    await expect(extractPdfPages(Buffer.from('%PDF-1.4 lixo'))).rejects.toMatchObject({ code: 'unreadable_pdf' })
    await expect(extractPdfPages(Buffer.from('não sou pdf'))).rejects.toMatchObject({ code: 'not_pdf' })
    expect(isPdfHeader(buildPdf(['x']))).toBe(true)
  })
})

describe('HTML', () => {
  const html = `<html><head><title>Loja &amp; Cia</title><style>.x{}</style></head><body>
    <script>alert(1)</script><h1>Bem-vindo</h1><p>Entregamos em <b>24h</b>&nbsp;no Brasil.</p>
    <a href="/sobre">Sobre</a><a href="https://outro.com/x">fora</a><a href="#topo">topo</a><a href="/logo.png">img</a>
    <a href="mailto:a@b.c">mail</a><a href='/contato#form'>Contato</a></body></html>`

  it('texto visível sem script/style, entidades decodificadas e título', () => {
    const text = htmlToText(html)
    expect(text.replace(/\s+/g, ' ')).toBe('Bem-vindo Entregamos em 24h no Brasil. Sobre fora topo img mail Contato')
    expect(text).not.toMatch(/alert|\.x\{/)
    expect(htmlTitle(html)).toBe('Loja & Cia')
  })

  it('links do mesmo host, sem âncora, estáticos nem mailto', () => {
    expect(sameHostLinks(html, new URL('https://loja.com/'))).toEqual(['https://loja.com/sobre', 'https://loja.com/contato'])
  })
})

describe('chunkText', () => {
  it('agrupa linhas até o limite e quebra linhas longas por frase/palavra', () => {
    expect(chunkText('a\nb\nc', 10)).toEqual(['a\nb\nc'])
    const long = Array.from({ length: 30 }, (_, i) => `Frase número ${i}.`).join(' ')
    const chunks = chunkText(long, 100)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every((c) => c.length <= 100)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
    expect(chunkText('   ')).toEqual([])
  })
})
