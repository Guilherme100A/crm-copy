// @crm/worker — Jobs BullMQ do CRM e consumidor do stream wsm:events.
// Ponto de registro (SPEC 2.4): cada tarefa acrescenta seus `export * from './<módulo>'` aqui, de forma aditiva.
export {}
export * from './boot/start'
export * from './boot/config'
export * from './consumers/framework'
export * from './registry'
export * from './consumers/chats'
export * from './jobs/flow-step'
export * from './jobs/flow-timer'
