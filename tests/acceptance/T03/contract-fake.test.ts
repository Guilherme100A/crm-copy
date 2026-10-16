// Executa a suíte de contrato pública de @crm/wa-port (subpath `./contract`) contra o FakeWaGateway.
// Com T03_SABOTAGE=1 (usado só por contract-coverage.test.ts, em subprocesso) o gateway é sabotado
// para provar que a suíte não é vazia: send/cancel/sessions/downloadMedia passam a falhar.
import { describe, it } from 'vitest'
import { importSubpath } from './support'

const TITLE = 'AC-T03-04 suíte de contrato de @crm/wa-port contra o FakeWaGateway'

const fail = (reason: unknown) => () => {
  throw reason instanceof Error ? reason : new Error(String(reason))
}

function sabotage(gw: any): any {
  const boom = async () => {
    throw new Error('sabotado (T03_SABOTAGE)')
  }
  const sessions = new Proxy(gw.sessions ?? {}, {
    get: (t, k) => (typeof t[k] === 'function' ? boom : t[k]),
  })
  return new Proxy(gw, {
    get(t, k) {
      if (k === 'sessions') return sessions
      if (['send', 'sendGroup', 'cancel', 'downloadMedia', 'fetchGroups'].includes(String(k))) return boom
      return Reflect.get(t, k)
    },
  })
}

let suite: ((...args: any[]) => unknown) | undefined
let Fake: any
let loadError: unknown
try {
  const contract = await importSubpath('contract')
  const fns = Object.entries(contract).filter(([, v]) => typeof v === 'function')
  suite = (fns.find(([k]) => k === 'defineWaGatewayContract') ?? fns.find(([k]) => /contract|suite/i.test(k)) ?? (typeof contract.default === 'function' ? ['default', contract.default] : fns[0]))?.[1] as any
  if (!suite) throw new Error('@crm/wa-port/contract não exporta função de suíte')
  const testing = await importSubpath('testing')
  Fake = testing.FakeWaGateway ?? testing.createFakeWaGateway
  if (typeof Fake !== 'function') throw new Error('@crm/wa-port/testing não exporta FakeWaGateway')
} catch (e) {
  loadError = e
}

describe(TITLE, () => {
  if (loadError || !suite) {
    it('AC-T03-04 carrega a suíte de contrato e o FakeWaGateway', fail(loadError))
    return
  }
  const make = () => {
    const gw = /^class\s/.test(Function.prototype.toString.call(Fake)) ? new Fake() : Fake()
    return process.env.T03_SABOTAGE === '1' ? sabotage(gw) : gw
  }
  suite(make)
})
