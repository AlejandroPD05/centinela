import type { NotificationChannelConfig, NotificationPayload } from '@centinela/shared';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { deliveries, incidentEvents, notificationChannels } from '../db/schema.js';
import { DELIVERY_BACKOFF_BASE_SECONDS, DELIVERY_MAX_ATTEMPTS } from './config.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Vale tanto la conexión como una transacción en curso. */
export type DbLike = Database | Transaction;

export interface EnqueueOptions {
  kind: 'down' | 'recovered' | 'ssl';
  incidentId?: string | null;
  payload: NotificationPayload;
}

/** Encola una entrega por cada canal activo del espacio del monitor. */
export async function enqueueDeliveries(
  db: DbLike,
  monitor: { id: string; workspaceId: string },
  options: EnqueueOptions,
): Promise<number> {
  const channels = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, monitor.workspaceId),
        eq(notificationChannels.enabled, true),
      ),
    );

  if (channels.length === 0) return 0;

  await db.insert(deliveries).values(
    channels.map((channel) => ({
      channelId: channel.id,
      monitorId: monitor.id,
      incidentId: options.incidentId ?? null,
      kind: options.kind,
      payload: options.payload,
    })),
  );

  return channels.length;
}

export interface ClaimedDelivery {
  id: string;
  attempts: number;
  payload: NotificationPayload;
  incidentId: string | null;
  channel: {
    id: string;
    name: string;
    type: 'discord' | 'webhook' | 'email';
    config: NotificationChannelConfig;
  };
}

/**
 * Reclama entregas vencidas subiendo `attempts` y aparcando el siguiente
 * intento con backoff exponencial (30 s, 60 s, 120 s…). Mismo patrón que los
 * monitores: la marca de reclamo es la mutación, así que el envío por red
 * puede vivir fuera de la transacción. Cada intento consume `attempts`, de
 * modo que un proceso que muera a mitad de envío también encaja (at-least-once
 * con tope de intentos).
 */
export async function claimDueDeliveries(db: Database, limit: number): Promise<ClaimedDelivery[]> {
  const due = db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.status, 'pending'), lte(deliveries.nextAttemptAt, sql`now()`)))
    .orderBy(asc(deliveries.nextAttemptAt))
    .limit(limit)
    .for('update', { skipLocked: true });

  const claimed = await db
    .update(deliveries)
    .set({
      attempts: sql`${deliveries.attempts} + 1`,
      nextAttemptAt: sql`now() + make_interval(secs => ${DELIVERY_BACKOFF_BASE_SECONDS} * power(2, ${deliveries.attempts}))`,
    })
    .where(inArray(deliveries.id, due))
    .returning();

  if (claimed.length === 0) return [];

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      inArray(
        notificationChannels.id,
        claimed.map((row) => row.channelId),
      ),
    );

  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));

  return claimed.flatMap((row) => {
    const channel = channelsById.get(row.channelId);
    if (!channel) return [];
    return [
      {
        id: row.id,
        attempts: row.attempts,
        payload: row.payload,
        incidentId: row.incidentId,
        channel: { id: channel.id, name: channel.name, type: channel.type, config: channel.config },
      },
    ];
  });
}

/**
 * Marca la entrega como enviada y apunta el evento `notified` en el timeline
 * de su incidencia (con el canal que entregó: hay uno por aviso entregado).
 */
export async function markDelivered(db: Database, delivery: ClaimedDelivery): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({ status: 'sent', sentAt: sql`now()`, lastError: null })
      .where(eq(deliveries.id, delivery.id));

    if (!delivery.incidentId) return;

    await tx.insert(incidentEvents).values({
      incidentId: delivery.incidentId,
      kind: 'notified',
      detail: `aviso enviado por ${delivery.channel.name}`,
    });
  });
}

/**
 * Anota el fallo del intento. El backoff ya quedó aparcado al reclamar; aquí
 * solo se decide si la entrega se agota (fallida) o se reintenta. Devuelve si
 * se agotaron los intentos, para que el worker lo registre.
 */
export async function markFailedAttempt(
  db: Database,
  delivery: ClaimedDelivery,
  error: string,
): Promise<boolean> {
  const exhausted = delivery.attempts >= DELIVERY_MAX_ATTEMPTS;

  await db
    .update(deliveries)
    .set({
      lastError: error,
      ...(exhausted ? { status: 'failed' as const } : {}),
    })
    .where(eq(deliveries.id, delivery.id));

  return exhausted;
}
