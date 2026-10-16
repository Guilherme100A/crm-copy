// @crm/wa-port — Fronteira WhatsApp: WaGateway, WaEvent v1 e fakes.
// Ponto de registro (SPEC 2.4): cada tarefa acrescenta seus `export * from './<módulo>'` aqui, de forma aditiva.
// O FakeWaGateway fica em `@crm/wa-port/testing` e a suíte de contrato em `@crm/wa-port/contract` (importa vitest).
export * from './gateway'
export * from './events'
export * from './errors'
