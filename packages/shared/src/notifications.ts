/**
 * Vocabulario de avisos: tipos, umbrales SSL y formatos de mensaje.
 *
 * Todos los canales (Discord, webhook, email) comparten el mismo
 * `NotificationPayload`; cada adaptador lo pinta a su manera. Los textos viven
 * aquí, en lógica pura, para poder probarlos sin red ni base de datos.
 */

export type NotificationKind = 'down' | 'recovered' | 'ssl';

export interface NotificationMonitor {
  id: string;
  name: string;
  slug: string;
  type: 'http' | 'tcp' | 'heartbeat';
  /** Objetivo legible: URL, host:puerto o cadencia del latido. */
  target: string;
}

export interface NotificationIncident {
  id: string;
  startedAt: string;
  cause: string | null;
  /** Duración en segundos; solo la trae el aviso de recuperación. */
  durationSeconds: number | null;
}

export interface NotificationSsl {
  expiresAt: string;
  issuer: string | null;
  daysLeft: number;
}

export interface NotificationPayload {
  kind: NotificationKind;
  at: string;
  monitor: NotificationMonitor;
  incident: NotificationIncident | null;
  ssl: NotificationSsl | null;
}

export const notificationChannelTypes = ['discord', 'webhook', 'email'] as const;
export type NotificationChannelType = (typeof notificationChannelTypes)[number];

export interface DiscordChannelConfig {
  webhookUrl: string;
}
export interface WebhookChannelConfig {
  url: string;
}
export interface EmailChannelConfig {
  to: string;
}
export type NotificationChannelConfig =
  DiscordChannelConfig | WebhookChannelConfig | EmailChannelConfig;

/** Umbrales de aviso por caducidad del certificado (días), de lejos a cerca. */
export const sslAlertThresholdDays = [30, 14, 7, 3, 1] as const;

/** Cuántos umbrales ha cruzado el certificado (0 = sin aviso pendiente). */
export function sslAlertStage(daysLeft: number): number {
  let stage = 0;
  for (const threshold of sslAlertThresholdDays) {
    if (daysLeft <= threshold) stage += 1;
  }
  return stage;
}

/** ¿Toca avisar? Solo cuando se cruza un umbral nuevo; nunca dos veces el mismo. */
export function shouldNotifySsl(daysLeft: number, lastNotifiedStage: number): boolean {
  return sslAlertStage(daysLeft) > lastNotifiedStage;
}

const kindLabels: Record<NotificationKind, string> = {
  down: 'CAÍDA',
  recovered: 'RECUPERADO',
  ssl: 'CERTIFICADO SSL',
};

const kindSummaries: Record<NotificationKind, string> = {
  down: 'El servicio no responde.',
  recovered: 'El servicio vuelve a responder.',
  ssl: 'El certificado TLS está a punto de caducar.',
};

/** Colores de estado, con el mismo criterio que la interfaz: color = estado. */
export const discordKindColors: Record<NotificationKind, number> = {
  down: 0xe5484d,
  recovered: 0x30a46c,
  ssl: 0xf5a524,
};

export function buildNotificationTitle(payload: NotificationPayload): string {
  return `[${kindLabels[payload.kind]}] ${payload.monitor.name}`;
}

export function buildNotificationText(payload: NotificationPayload): string {
  const lines = [
    buildNotificationTitle(payload),
    `objetivo: ${payload.monitor.target}`,
    `momento: ${payload.at}`,
  ];

  if (payload.kind === 'ssl' && payload.ssl) {
    lines.push(
      `caduca: ${payload.ssl.expiresAt} (quedan ${payload.ssl.daysLeft} días)`,
      `emisor: ${payload.ssl.issuer ?? 'desconocido'}`,
    );
  } else if (payload.incident) {
    if (payload.incident.cause) lines.push(`motivo: ${payload.incident.cause}`);
    if (payload.incident.durationSeconds !== null) {
      lines.push(`duración: ${formatDuration(payload.incident.durationSeconds)}`);
    }
  }

  return lines.join('\n');
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  timestamp: string;
}

export function buildDiscordMessage(payload: NotificationPayload): {
  content: string;
  embeds: DiscordEmbed[];
} {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'objetivo', value: payload.monitor.target, inline: true },
  ];

  if (payload.kind === 'ssl' && payload.ssl) {
    fields.push({
      name: 'caduca',
      value: `${payload.ssl.expiresAt} (quedan ${payload.ssl.daysLeft} días)`,
      inline: true,
    });
    fields.push({
      name: 'emisor',
      value: payload.ssl.issuer ?? 'desconocido',
      inline: true,
    });
  } else if (payload.incident) {
    if (payload.incident.cause) {
      fields.push({ name: 'motivo', value: payload.incident.cause, inline: false });
    }
    if (payload.incident.durationSeconds !== null) {
      fields.push({
        name: 'duración',
        value: formatDuration(payload.incident.durationSeconds),
        inline: true,
      });
    }
  }

  return {
    content: buildNotificationTitle(payload),
    embeds: [
      {
        title: `${payload.monitor.slug} · ${payload.kind}`,
        description: kindSummaries[payload.kind],
        color: discordKindColors[payload.kind],
        fields,
        timestamp: payload.at,
      },
    ],
  };
}

/** Cuerpo para webhooks genéricos: el payload entero más un resumen legible. */
export function buildWebhookBody(payload: NotificationPayload): Record<string, unknown> {
  return { ...payload, summary: buildNotificationText(payload) };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}
