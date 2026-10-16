import { pgEnum } from 'drizzle-orm/pg-core'

// Estados da sessão (SPEC 3.2). Fonte única de domínio: packages/core/src/session/states.ts.
export const SESSION_STATUSES = ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

// Estados da mensagem (SPEC 3.3).
export const MESSAGE_STATUSES = [
  'queued',
  'processing',
  'sent',
  'delivered',
  'read',
  'failed',
  'retrying',
  'cancelled',
] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

export const MESSAGE_DIRECTIONS = ['outbound', 'inbound'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

// Canais de alerta (AC-T11-02).
export const WEBHOOK_CHANNELS = ['discord', 'telegram', 'email', 'http'] as const
export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number]

export const sessionStatusEnum = pgEnum('session_status', SESSION_STATUSES)
export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES)
export const messageDirectionEnum = pgEnum('message_direction', MESSAGE_DIRECTIONS)
export const proxyProtocolEnum = pgEnum('proxy_protocol', PROXY_PROTOCOLS)
export const webhookChannelEnum = pgEnum('webhook_channel', WEBHOOK_CHANNELS)
