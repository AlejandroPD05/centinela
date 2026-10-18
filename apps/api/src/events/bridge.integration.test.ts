import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFileIfPresent } from '../config/env.js';
import { publishStatus, startStatusBridge, type StatusBridge } from '../events/bridge.js';
import { subscribe, type CheckEvent } from '../events/hub.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba del puente SSE se salta.');
}

/** Logger mudo: los tests no ensucian la salida. */
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as FastifyBaseLogger;

const evento = (monitorId: string): CheckEvent => ({
  type: 'check',
  monitorId,
  monitorSlug: 'api-de-ejemplo',
  state: 'up',
  status: 'up',
  latencyMs: 42,
  changed: true,
  at: new Date().toISOString(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Integración real del puente: lo publicado con `publishStatus` (NOTIFY) llega
 * a un oyente del hub local, y tras `stop()` deja de llegar. El primer NOTIFY
 * puede perderse si el LISTEN aún no está abierto, así que el primer test
 * publica en bucle hasta recibir.
 */
describe.runIf(dbAvailable)('puente SSE — LISTEN/NOTIFY en PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let bridge: StatusBridge;
  const workspaceId = randomUUID();

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_bridge');
    bridge = startStatusBridge(ephemeral.url, silentLog);
  });

  afterAll(async () => {
    await bridge.stop();
    await ephemeral.drop();
  });

  it('reparte el aviso publicado por NOTIFY entre los oyentes del hub', async () => {
    const received: CheckEvent[] = [];
    const unsubscribe = subscribe(workspaceId, (event) => {
      if (event.type === 'check') received.push(event);
    });

    const expected = evento(randomUUID());
    const deadline = Date.now() + 10_000;

    while (received.length === 0 && Date.now() < deadline) {
      await publishStatus(ephemeral.db, workspaceId, expected);
      await sleep(200);
    }

    unsubscribe();

    expect(received[0]).toEqual(expected);
  });

  it('tras stop() deja de repartir lo que se publique', async () => {
    await bridge.stop();

    const received: string[] = [];
    const unsubscribe = subscribe(workspaceId, () => received.push('evento'));

    await publishStatus(ephemeral.db, workspaceId, evento(randomUUID()));
    await sleep(400);

    unsubscribe();
    expect(received).toEqual([]);
  });
});
