// AC-T80-01..04: vozes clonadas (ElevenLabs) pela API, contra o fake HTTP local da ElevenLabs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addKey, createVoice, fund, owner, preview, ready, sample, startEnv, type Env } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const errorCode = (r: any) => r.body?.error?.details?.error_code ?? r.json?.error?.details?.error_code

describe('T80 — criação com amostras (AC-T80-01)', () => {
  for (const n of [1, 3]) {
    it(`AC-T80-01 ${n} amostra(s) aceita(s) chama a clonagem do provedor e a voz fica pending`, async () => {
      const u = await ready(env)
      const files = Array.from({ length: n }, (_, i) => sample(`voz-${i}.mp3`))
      const before = env.fake.clones.length
      const r = await createVoice(env, u, { name: `Minha voz ${n}`, language: 'pt' }, files)
      expect(r.status, r.text).toBe(201)
      expect(r.body.voice).toMatchObject({ name: `Minha voz ${n}`, language: 'pt', status: 'pending', samples_count: n })
      expect(env.fake.clones.length).toBe(before + 1)
      const clone = env.fake.clones.at(-1)
      expect(clone.name).toBe(`Minha voz ${n}`)
      expect(clone.files).toHaveLength(n)
      expect(r.body.voice.provider_voice_id).toBeTruthy()
    })
  }

  it('AC-T80-01 os formatos de 07#3.7 são aceitos (MP3/WAV/OGG/M4A/AAC/WEBM/FLAC)', async () => {
    const u = await ready(env)
    const formats: Array<[string, string]> = [
      ['a.wav', 'audio/wav'],
      ['b.ogg', 'audio/ogg; codecs=opus'],
      ['c.m4a', 'audio/x-m4a'],
    ]
    expect((await createVoice(env, u, { name: 'Formatos 1', language: 'en' }, formats.map(([n, t]) => sample(n, t)))).status).toBe(201)
    const more: Array<[string, string]> = [
      ['d.aac', 'audio/aac'],
      ['e.webm', 'audio/webm'],
      ['f.flac', 'audio/flac'],
    ]
    expect((await createVoice(env, u, { name: 'Formatos 2', language: 'es' }, more.map(([n, t]) => sample(n, t)))).status).toBe(201)
  })

  it('AC-T80-01 0 ou 4 amostras → 422 sem chamar a clonagem', async () => {
    const u = await ready(env)
    const before = env.fake.clones.length
    const zero = await createVoice(env, u, { name: 'Sem áudio', language: 'pt' }, [])
    expect(zero.status, zero.text).toBe(422)
    expect(zero.body.error.code).toBe('VALIDATION_ERROR')
    const four = await createVoice(env, u, { name: 'Quatro', language: 'pt' }, [1, 2, 3, 4].map((i) => sample(`x${i}.mp3`)))
    expect(four.status, four.text).toBe(422)
    expect(env.fake.clones.length).toBe(before)
  })

  it('AC-T80-01 formato fora da lista, idioma inválido e nome ausente → 422', async () => {
    const u = await ready(env)
    const bad = await createVoice(env, u, { name: 'Texto', language: 'pt' }, [sample('nota.txt', 'text/plain')])
    expect(bad.status).toBe(422)
    expect(errorCode(bad)).toBe('unsupported_audio')
    expect((await createVoice(env, u, { name: 'Idioma', language: 'fr' }, [sample()])).status).toBe(422)
    expect((await createVoice(env, u, { language: 'pt' }, [sample()])).status).toBe(422)
  })
})

describe('T80 — prévia e manter (AC-T80-02)', () => {
  it('AC-T80-02 preview sintetiza um texto curto e devolve áudio; keep muda para kept', async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Prévia', language: 'pt' }, [sample()])).body.voice
    const calls = env.fake.ttsCalls.length
    const p = await preview(env, u, v.id, 'Olá, esta é a minha voz.')
    expect(p.status).toBe(200)
    expect(p.contentType).toMatch(/^audio\//)
    expect(p.bytes.length).toBeGreaterThan(0)
    expect(env.fake.ttsCalls.length).toBe(calls + 1)
    expect(JSON.stringify(env.fake.ttsCalls.at(-1))).toContain(v.provider_voice_id)

    const k = await u.c.post(`/api/ai-voices/${v.id}/keep`, {})
    expect(k.status, k.text).toBe(200)
    expect(k.body.voice.status).toBe('kept')
    expect((await u.c.post(`/api/ai-voices/${v.id}/keep`, {})).body.voice.status).toBe('kept')
    const list = await u.c.get('/api/ai-voices')
    expect(list.body.items.find((x: any) => x.id === v.id).status).toBe('kept')
  })

  it('AC-T80-02 preview sem texto usa a frase padrão; texto acima de 300 caracteres → 422', async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Padrão', language: 'pt' }, [sample()])).body.voice
    const p = await preview(env, u, v.id)
    expect(p.status).toBe(200)
    expect(p.bytes.length).toBeGreaterThan(0)
    expect((await preview(env, u, v.id, 'x'.repeat(301))).status).toBe(422)
  })

  it('AC-T80-02 voz de outra empresa → 404 no preview e no keep', async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Privada', language: 'pt' }, [sample()])).body.voice
    const stranger = await ready(env)
    expect((await preview(env, stranger, v.id, 'oi')).status).toBe(404)
    expect((await stranger.c.post(`/api/ai-voices/${v.id}/keep`, {})).status).toBe(404)
  })
})

describe('T80 — excluir voz em uso (AC-T80-03)', () => {
  it('AC-T80-03 excluir voz usada por agente volta o agente para a voz padrão e avisa na resposta', async () => {
    const u = await ready(env)
    await addKey(u, 'openai')
    const v = (await createVoice(env, u, { name: 'Em uso', language: 'pt' }, [sample()])).body.voice
    await u.c.post(`/api/ai-voices/${v.id}/keep`, {})
    const ag = await u.c.post('/api/ai-agents', { name: 'Agente com voz', generated_prompt: 'Atenda bem.', model: { provider: 'openai', model: 'gpt-t80' }, settings: {}, skills: [] })
    expect(ag.status, ag.text).toBe(201)
    const agentId = ag.body.agent.id
    const patch = await u.c.patch(`/api/ai-agents/${agentId}`, { settings: { audio_voice: v.provider_voice_id } })
    expect(patch.status, patch.text).toBe(200)

    const del = await u.c.delete(`/api/ai-voices/${v.id}`)
    expect(del.status, del.text).toBe(200)
    expect(del.body.deleted).toBe(true)
    expect(del.body.removed_from_agents.map((a: any) => a.id)).toEqual([agentId])
    expect(String(del.body.warning)).toContain('1 agente')
    expect(env.fake.deleted).toContain(v.provider_voice_id)

    const agent = (await u.c.get(`/api/ai-agents/${agentId}`)).body.agent
    expect(agent.settings?.audio_voice ?? '').toBe('')
    expect((await u.c.get('/api/ai-voices')).body.items.map((x: any) => x.id)).not.toContain(v.id)
  })

  it('AC-T80-03 excluir voz sem uso não traz aviso', async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Livre', language: 'pt' }, [sample()])).body.voice
    const del = await u.c.delete(`/api/ai-voices/${v.id}`)
    expect(del.status).toBe(200)
    expect(del.body.removed_from_agents).toEqual([])
    expect(del.body.warning ?? null).toBeNull()
  })
})

describe('T80 — chave e medição (AC-T80-04)', () => {
  it('AC-T80-04 sem chave ElevenLabs (empresa nem plataforma) → 422 provider_not_configured, sem chamar o provedor', async () => {
    const u = await owner(env)
    await fund(env, u.companyId)
    const before = env.fake.clones.length
    const r = await createVoice(env, u, { name: 'Sem chave', language: 'pt' }, [sample()])
    expect(r.status, r.text).toBe(422)
    expect(r.body.error.code).toBe('VALIDATION_ERROR')
    expect(errorCode(r)).toBe('provider_not_configured')
    expect(env.fake.clones.length).toBe(before)
  })

  it('AC-T80-04 com a chave da plataforma (env) funciona sem chave da empresa', async () => {
    const u = await owner(env)
    await fund(env, u.companyId)
    process.env.ELEVENLABS_API_KEY = 'el-plataforma-t80'
    try {
      const r = await createVoice(env, u, { name: 'Chave da plataforma', language: 'pt' }, [sample()])
      expect(r.status, r.text).toBe(201)
      expect(env.fake.clones.at(-1).apiKey).toBe('el-plataforma-t80')
    } finally {
      delete process.env.ELEVENLABS_API_KEY
    }
  })

  it("AC-T80-04 o uso de TTS do preview é medido em ai_usage com feature = 'tts'", async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Medida', language: 'pt' }, [sample()])).body.voice
    const text = 'Teste de medição de voz.'
    const n0 = (await env.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [u.companyId]))[0].n
    expect((await preview(env, u, v.id, text)).status).toBe(200)
    const rows = await env.q(`SELECT feature, kind::text AS kind, provider, units FROM crm.ai_usage WHERE company_id = $1 ORDER BY created_at DESC`, [u.companyId])
    expect(rows.length).toBe(n0 + 1)
    expect(rows[0]).toMatchObject({ feature: 'tts', kind: 'tts', provider: 'elevenlabs' })
    expect(Number(rows[0].units)).toBe(text.length)
    // clonar não é medido: só a prévia gerou uso
    expect(rows.filter((r: any) => r.feature === 'tts')).toHaveLength(1)
  })

  it('AC-T80-04 carteira sem saldo → preview recusado (429 QUOTA_EXCEEDED) sem sintetizar', async () => {
    const u = await ready(env)
    const v = (await createVoice(env, u, { name: 'Sem saldo', language: 'pt' }, [sample()])).body.voice
    await env.q(`UPDATE crm.ai_wallets SET balance_credits = 0, max_overrun_credits = 0, status = 'exhausted' WHERE company_id = $1`, [u.companyId])
    const calls = env.fake.ttsCalls.length
    const p = await preview(env, u, v.id, 'oi')
    expect(p.status).toBe(429)
    expect(p.json?.error?.code).toBe('QUOTA_EXCEEDED')
    expect(env.fake.ttsCalls.length).toBe(calls)
  })
})
