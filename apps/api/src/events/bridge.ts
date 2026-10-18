import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { Client } from 'pg';
import type { Database } from '../db/client.js';
import { publish, type CheckEvent } from './hub.js';

/**
 * Canal de PostgreSQL por el que viajan los avisos en vivo. Con una sola
 * instancia es un rodeo innecesario, pero es barato (milisegundos) y hace que
 * el SSE funcione igual con varias: cualquier proceso puede publicar y todos
 * reparten lo que llega entre sus propias conexiones.
 */
export const STATUS_CHANNEL = 'centinela_status';

interface StatusPayload {
  workspaceId: string;
  event: CheckEvent;
}

/** Publica un aviso de estado en el canal (NOTIFY). */
export async function publishStatus(
  db: Database,
  workspaceId: string,
  event: CheckEvent,
): Promise<void> {
  const payload = JSON.stringify({ workspaceId, event } satisfies StatusPayload);
  await db.execute(sql`select pg_notify(${STATUS_CHANNEL}, ${payload})`);
}

export interface StatusBridge {
  /** Corta la escucha y cualquier reconexión pendiente. */
  stop(): Promise<void>;
}

/** Espera entre intentos de reconexión del puente. */
const RETRY_MS = 5_000;

/**
 * Abre una conexión dedicada (fuera del pool) que escucha el canal y reparte
 * cada aviso por el hub local. Si la conexión se cae —o no puede nacer— se
 * reintenta sola cada pocos segundos: la status page sigue sirviendo HTML
 * aunque el flujo en vivo esté de vacaciones.
 */
export function startStatusBridge(connectionString: string, log: FastifyBaseLogger): StatusBridge {
  let stopped = false;
  let client: Client | null = null;
  let retry: NodeJS.Timeout | null = null;

  const schedule = (reason: string, error?: unknown): void => {
    if (stopped || retry) return;

    const doomed = client;
    client = null;
    void doomed?.end().catch(() => undefined);

    log.warn({ err: error, reintentoMs: RETRY_MS }, `puente SSE caído (${reason}); se reintenta`);

    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, RETRY_MS);
    retry.unref();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;

    const next = new Client({ connectionString });
    client = next;

    next.on('notification', (message) => {
      if (message.channel !== STATUS_CHANNEL || !message.payload) return;

      try {
        const { workspaceId, event } = JSON.parse(message.payload) as StatusPayload;
        publish(workspaceId, event);
      } catch (error) {
        log.warn({ err: error }, 'aviso en vivo ilegible en el canal de PostgreSQL');
      }
    });

    next.on('error', (error) => {
      if (client === next) schedule('error de conexión', error);
    });

    try {
      await next.connect();
      await next.query(`listen ${STATUS_CHANNEL}`);
      log.info({ canal: STATUS_CHANNEL }, 'puente SSE escuchando a PostgreSQL');
    } catch (error) {
      if (client === next) schedule('no se pudo abrir', error);
    }
  };

  void connect();

  return {
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;

      const doomed = client;
      client = null;
      await doomed?.end().catch(() => undefined);
    },
  };
}
