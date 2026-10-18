import {
  buildDiscordMessage,
  buildNotificationText,
  buildNotificationTitle,
  buildWebhookBody,
  type DiscordChannelConfig,
  type EmailChannelConfig,
  type NotificationChannelConfig,
  type NotificationChannelType,
  type NotificationPayload,
  type WebhookChannelConfig,
} from '@centinela/shared';
import { RESEND_BASE_URL } from './config.js';

export interface ChannelTarget {
  type: NotificationChannelType;
  name: string;
  config: NotificationChannelConfig;
}

export interface SendOptions {
  timeoutMs: number;
  resendApiKey?: string | undefined;
  emailFrom?: string | undefined;
  /** Base de la API de Resend; los tests apuntan a un servidor local. */
  resendBaseUrl?: string;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Entrega un aviso por el canal indicado. Nunca lanza: cualquier problema
 * (red, código de respuesta, configuración) se devuelve como motivo legible.
 */
export async function sendDelivery(
  channel: ChannelTarget,
  payload: NotificationPayload,
  options: SendOptions,
): Promise<SendResult> {
  try {
    switch (channel.type) {
      case 'discord':
        return await sendDiscord(channel.config as DiscordChannelConfig, payload, options);
      case 'webhook':
        return await sendWebhook(channel.config as WebhookChannelConfig, payload, options);
      case 'email':
        return await sendEmail(channel.config as EmailChannelConfig, payload, options);
      default:
        return { ok: false, error: `tipo de canal desconocido: ${String(channel.type)}` };
    }
  } catch (error) {
    return { ok: false, error: describeSendError(error, options.timeoutMs) };
  }
}

async function sendDiscord(
  config: DiscordChannelConfig,
  payload: NotificationPayload,
  options: SendOptions,
): Promise<SendResult> {
  if (!config.webhookUrl) {
    return { ok: false, error: 'el canal Discord no tiene webhook URL configurado' };
  }

  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildDiscordMessage(payload)),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) return { ok: false, error: `Discord respondió ${response.status}` };
  return { ok: true };
}

async function sendWebhook(
  config: WebhookChannelConfig,
  payload: NotificationPayload,
  options: SendOptions,
): Promise<SendResult> {
  if (!config.url) {
    return { ok: false, error: 'el canal webhook no tiene URL configurada' };
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWebhookBody(payload)),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) return { ok: false, error: `el webhook respondió ${response.status}` };
  return { ok: true };
}

async function sendEmail(
  config: EmailChannelConfig,
  payload: NotificationPayload,
  options: SendOptions,
): Promise<SendResult> {
  if (!config.to) return { ok: false, error: 'el canal email no tiene destinatario' };
  if (!options.resendApiKey || !options.emailFrom) {
    return {
      ok: false,
      error: 'el canal email no está configurado: faltan RESEND_API_KEY y EMAIL_FROM',
    };
  }

  const response = await fetch(`${options.resendBaseUrl ?? RESEND_BASE_URL}/emails`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.resendApiKey}`,
    },
    body: JSON.stringify({
      from: options.emailFrom,
      to: [config.to],
      subject: buildNotificationTitle(payload),
      text: buildNotificationText(payload),
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) return { ok: false, error: `Resend respondió ${response.status}` };
  return { ok: true };
}

function describeSendError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `tiempo agotado tras ${timeoutMs} ms`;
  }

  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const detail =
    cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);

  return `no se pudo entregar el aviso: ${detail}`;
}
