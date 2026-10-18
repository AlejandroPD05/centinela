import { describe, expect, it } from 'vitest';
import {
  buildDiscordMessage,
  buildNotificationText,
  buildNotificationTitle,
  buildWebhookBody,
  discordKindColors,
  formatDuration,
  shouldNotifySsl,
  sslAlertStage,
  type NotificationPayload,
} from './notifications.js';

const basePayload = (overrides: Partial<NotificationPayload> = {}): NotificationPayload => ({
  kind: 'down',
  at: '2026-10-18T10:00:00.000Z',
  monitor: {
    id: 'monitor-1',
    name: 'API de ejemplo',
    slug: 'api-de-ejemplo',
    type: 'http',
    target: 'https://api.ejemplo.test/',
  },
  incident: {
    id: 'incident-1',
    startedAt: '2026-10-18T09:00:00.000Z',
    cause: 'conexión rechazada',
    durationSeconds: null,
  },
  ssl: null,
  ...overrides,
});

describe('sslAlertStage', () => {
  it('cuenta los umbrales cruzados', () => {
    expect(sslAlertStage(31)).toBe(0);
    expect(sslAlertStage(30)).toBe(1);
    expect(sslAlertStage(15)).toBe(1);
    expect(sslAlertStage(14)).toBe(2);
    expect(sslAlertStage(7)).toBe(3);
    expect(sslAlertStage(3)).toBe(4);
    expect(sslAlertStage(1)).toBe(5);
    expect(sslAlertStage(0)).toBe(5);
    expect(sslAlertStage(-4)).toBe(5);
  });
});

describe('shouldNotifySsl', () => {
  it('solo avisa cuando se cruza un umbral nuevo', () => {
    expect(shouldNotifySsl(31, 0)).toBe(false);
    expect(shouldNotifySsl(30, 0)).toBe(true);
    expect(shouldNotifySsl(30, 1)).toBe(false);
    expect(shouldNotifySsl(20, 1)).toBe(false);
    expect(shouldNotifySsl(14, 1)).toBe(true);
  });
});

describe('buildNotificationTitle', () => {
  it('etiqueta el aviso según el tipo', () => {
    expect(buildNotificationTitle(basePayload())).toBe('[CAÍDA] API de ejemplo');
    expect(buildNotificationTitle(basePayload({ kind: 'recovered' }))).toBe(
      '[RECUPERADO] API de ejemplo',
    );
    expect(buildNotificationTitle(basePayload({ kind: 'ssl' }))).toBe(
      '[CERTIFICADO SSL] API de ejemplo',
    );
  });
});

describe('buildNotificationText', () => {
  it('incluye objetivo, motivo y duración en recuperaciones', () => {
    const text = buildNotificationText(
      basePayload({
        kind: 'recovered',
        incident: {
          id: 'incident-1',
          startedAt: '2026-10-18T09:00:00.000Z',
          cause: 'conexión rechazada',
          durationSeconds: 900,
        },
      }),
    );

    expect(text).toContain('[RECUPERADO] API de ejemplo');
    expect(text).toContain('objetivo: https://api.ejemplo.test/');
    expect(text).toContain('motivo: conexión rechazada');
    expect(text).toContain('duración: 15 min');
  });

  it('en avisos SSL habla de caducidad y emisor', () => {
    const text = buildNotificationText(
      basePayload({
        kind: 'ssl',
        incident: null,
        ssl: { expiresAt: '2026-11-01T00:00:00.000Z', issuer: 'Let’s Encrypt', daysLeft: 14 },
      }),
    );

    expect(text).toContain('quedan 14 días');
    expect(text).toContain('emisor: Let’s Encrypt');
  });
});

describe('buildDiscordMessage', () => {
  it('pinta el estado con su color y sus campos', () => {
    const message = buildDiscordMessage(basePayload());

    expect(message.content).toBe('[CAÍDA] API de ejemplo');
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]?.color).toBe(discordKindColors.down);
    expect(message.embeds[0]?.timestamp).toBe('2026-10-18T10:00:00.000Z');
    expect(message.embeds[0]?.fields.map((field) => field.name)).toContain('motivo');
  });

  it('colorea la recuperación y el aviso SSL', () => {
    expect(buildDiscordMessage(basePayload({ kind: 'recovered' })).embeds[0]?.color).toBe(
      discordKindColors.recovered,
    );
    expect(
      buildDiscordMessage(
        basePayload({
          kind: 'ssl',
          incident: null,
          ssl: { expiresAt: '2026-11-01T00:00:00.000Z', issuer: null, daysLeft: 7 },
        }),
      ).embeds[0]?.color,
    ).toBe(discordKindColors.ssl);
  });
});

describe('buildWebhookBody', () => {
  it('envuelve el payload con un resumen legible', () => {
    const body = buildWebhookBody(basePayload());

    expect(body.kind).toBe('down');
    expect(body.summary).toContain('[CAÍDA] API de ejemplo');
  });
});

describe('formatDuration', () => {
  it('redondea a la unidad legible', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(90)).toBe('1 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3660)).toBe('1 h 1 min');
    expect(formatDuration(86400)).toBe('1 d');
    expect(formatDuration(90000)).toBe('1 d 1 h');
  });
});
