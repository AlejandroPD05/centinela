import type { CheckStatus } from '@centinela/shared';

/**
 * Resultado de ejecutar un check.
 *
 * Semántica:
 * - `up` / `degraded`: el servicio respondió correctamente (rápido / lento).
 * - `down`: el destino no respondió bien (código erróneo, sin palabra clave,
 *   conexión rechazada, DNS caído, tiempo agotado…). El servicio está mal.
 * - `error`: el check no llegó a medir el servicio (configuración inválida o
 *   destino bloqueado por la guarda SSRF).
 */
export interface CheckOutcome {
  status: CheckStatus;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}
