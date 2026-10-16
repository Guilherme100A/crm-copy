import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { repoFiles, rootPath } from '../helpers/exec'
import { BRAND_RE } from './contract'

// Fora do escopo do AC: a própria spec e a pasta de orquestração local (não faz parte do produto).
const EXCLUDED = [/^spec\//, /^\.maestri\//]
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp3|mp4|ogg|opus|wav|webm|pdf|zip|gz|tgz|wasm)$/i

const candidates = () => repoFiles().filter((f) => !EXCLUDED.some((re) => re.test(f)))

describe('T00 — marca neutra', () => {
  it('AC-T00-06 nenhum arquivo do repositório fora de spec/ contém a marca proibida (case-insensitive)', () => {
    const files = candidates()
    expect(files.length, 'nenhum arquivo encontrado no repositório').toBeGreaterThan(0)
    const hits: string[] = []
    for (const f of files) {
      if (BINARY.test(f)) continue
      const buf = readFileSync(rootPath(f))
      if (buf.includes(0)) continue // binário
      buf
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => BRAND_RE.test(line) && hits.push(`${f}:${i + 1}`))
    }
    expect(hits, `ocorrências: ${hits.slice(0, 20).join(', ')}`).toEqual([])
  })

  it('AC-T00-06 nenhum caminho de arquivo fora de spec/ contém a marca proibida', () => {
    const bad = candidates().filter((f) => BRAND_RE.test(f))
    expect(bad).toEqual([])
  })
})
