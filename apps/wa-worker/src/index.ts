// @crm/wa-worker — Dono dos sockets do WhatsApp (wa-engine) e RPC interno.
// Ponto de registro (SPEC 2.4): cada tarefa acrescenta seus `export * from './<módulo>'` aqui, de forma aditiva.
export {}
export * from './boot/config'
export * from './boot/start'
export * from './boot/fake-control'
export * from './boot/blob-refs'
export * from './boot/attach-queue'
export * from './rpc/server'
export * from './rpc/targets'
export * from './rpc/errors'
export * from './rpc/dedupe'
