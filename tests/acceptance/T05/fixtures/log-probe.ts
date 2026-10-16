// Processo-sonda do AC-T05-02: usa o createLogger público de @crm/node-kit e escreve no stdout (destino padrão).
// Uso: tsx log-probe.ts <caminho absoluto de packages/node-kit/src/index.ts>
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) throw new Error('caminho do node-kit ausente')
const kit = await import(pathToFileURL(entry).href)
const logger = kit.createLogger()

// Exemplo literal do AC (com valores distintivos para busca no output).
logger.info(
  { user: { password: 'PASSWORD-AC-1', apiKey: 'APIKEY-AC-1' }, creds: { me: { id: 'CREDS-ME-ID-1' }, noiseKey: 'CREDS-NOISE-1' }, visible: 'VISIBLE-AC' },
  'case-ac',
)

// Todas as chaves da lista, em profundidade.
logger.info(
  {
    a: {
      b: {
        c: {
          d: {
            password: 'PASSWORD-DEEP',
            token: 'TOKEN-DEEP',
            secret: 'SECRET-DEEP',
            apiKey: 'APIKEY-DEEP',
            creds: 'CREDS-DEEP',
            keys: { 'pre-key-1': 'KEYS-DEEP' },
            noiseKey: { private: 'NOISEKEY-DEEP' },
            signedIdentityKey: 'SIGNEDIDENTITY-DEEP',
            authorization: 'Bearer AUTHORIZATION-DEEP',
            cookie: 'crm_session=COOKIE-DEEP',
          },
        },
      },
      visible: 'VISIBLE-DEEP',
    },
  },
  'case-deep',
)

// Dentro de arrays.
logger.info({ list: [{ user: { password: 'PASSWORD-ARRAY' } }, { token: 'TOKEN-ARRAY' }] }, 'case-array')

// Child logger: bindings e objeto do log; neto também.
const child = logger.child({ token: 'TOKEN-BINDING', ctx: { apiKey: 'APIKEY-BINDING', visible: 'VISIBLE-CHILD' } })
child.info({ user: { password: 'PASSWORD-CHILD' }, secret: 'SECRET-CHILD' }, 'case-child')
const grandchild = child.child({ req: { headers: { authorization: 'Bearer AUTHORIZATION-GRANDCHILD', cookie: 'COOKIE-GRANDCHILD' } } })
grandchild.warn({ creds: { signedIdentityKey: 'SIGNEDIDENTITY-GRANDCHILD' } }, 'case-grandchild')

// Nível error também redige.
logger.error({ err: new Error('boom'), payload: { secret: 'SECRET-ERROR' } }, 'case-error')

if (typeof logger.flush === 'function')
  await Promise.race([new Promise<void>((r) => logger.flush(() => r())), new Promise((r) => setTimeout(r, 1000))])
