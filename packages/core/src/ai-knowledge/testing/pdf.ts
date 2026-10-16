// Gerador de PDFs mínimos para testes (T52): páginas com texto (Helvetica, WinAnsi), PDF sem texto e PDF com
// dicionário /Encrypt (o pdf.js pede senha → `encrypted_pdf`). Nada de arquivo binário no repositório.

export interface BuildPdfOptions {
  /** Adiciona `/Encrypt` (handler padrão R2) no trailer: abrir exige senha. */
  encrypted?: boolean
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/** PDF 1.4 com uma página por item de `pages` (linhas separadas por `\n`); `''` = página sem texto. */
export function buildPdf(pages: string[], opts: BuildPdfOptions = {}): Buffer {
  const objects: string[] = []
  const add = (body: string) => objects.push(body) // id = índice + 1
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // Pages (preenchido depois)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const pageIds: number[] = []
  for (const text of pages) {
    const lines = text ? text.split('\n') : []
    const ops = lines.length ? `BT /F1 12 Tf 14 TL 50 780 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET` : ''
    const length = Buffer.byteLength(ops, 'latin1')
    add(`<< /Length ${length} >>\nstream\n${ops}\nendstream`)
    const contentId = objects.length
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
    pageIds.push(objects.length)
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  let encryptRef = ''
  if (opts.encrypted) {
    add(`<< /Filter /Standard /V 1 /R 2 /O <${'a1'.repeat(32)}> /U <${'b2'.repeat(32)}> /P -4 >>`)
    encryptRef = ` /Encrypt ${objects.length} 0 R /ID [<${'c3'.repeat(16)}> <${'c3'.repeat(16)}>]`
  }
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
