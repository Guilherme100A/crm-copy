// Sonda do AC-T117-03: sobe o apps/api/src/server.ts real e, ao receber "SIGTERM" no stdin,
// emite process.emit('SIGTERM') (no Windows, sinal real de outro processo não chega aos handlers).
// Uso: node --conditions=development --import tsx server-harness.ts <caminho absoluto de apps/api/src/server.ts>
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) throw new Error('caminho do server.ts ausente')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  if (chunk.includes('SIGTERM')) {
    process.stdout.write('[harness] SIGTERM\n')
    process.emit('SIGTERM')
  }
})
// stdin não deve segurar o processo vivo depois do shutdown
process.stdin.unref?.()

await import(pathToFileURL(entry).href)
