import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigError, loadConfig } from './config'

const schema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['info', 'debug']).optional(),
})

describe('loadConfig (AC-T05-05)', () => {
  it('valida e devolve a saída tipada', () => {
    const cfg = loadConfig(schema, { DATABASE_URL: 'pg', REDIS_URL: 'r', PORT: '8080' })
    expect(cfg).toEqual({ DATABASE_URL: 'pg', REDIS_URL: 'r', PORT: 8080 })
  })

  it('variável obrigatória ausente → erro listando o nome', () => {
    let err: unknown
    try {
      loadConfig(schema, { REDIS_URL: '' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    const ce = err as ConfigError
    expect(ce.message).toContain('DATABASE_URL')
    expect(ce.message).toContain('REDIS_URL')
    expect(ce.names).toEqual(['DATABASE_URL', 'REDIS_URL'])
    expect(ce.issues.every((i) => i.missing)).toBe(true)
  })

  it('valor inválido lista o nome sem vazar o valor', () => {
    expect(() => loadConfig(schema, { DATABASE_URL: 'a', REDIS_URL: 'b', LOG_LEVEL: 'segredo-x' })).toThrow(/LOG_LEVEL/)
    try {
      loadConfig(schema, { DATABASE_URL: 'a', REDIS_URL: 'b', LOG_LEVEL: 'segredo-x' })
    } catch (e) {
      expect((e as Error).message).not.toContain('segredo-x')
    }
  })

  it('usa process.env por padrão', () => {
    process.env.NODE_KIT_TEST_VAR = 'ok'
    expect(loadConfig(z.object({ NODE_KIT_TEST_VAR: z.string() }))).toEqual({ NODE_KIT_TEST_VAR: 'ok' })
    delete process.env.NODE_KIT_TEST_VAR
  })
})
