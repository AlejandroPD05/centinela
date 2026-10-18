import type { monitors } from '../db/schema.js';
import { describeCheckError } from './errors.js';
import { checkHttp } from './http.js';
import { checkTcp } from './tcp.js';
import type { CheckOutcome } from './types.js';

export type MonitorRow = typeof monitors.$inferSelect;

export interface RunCheckOptions {
  allowPrivateTargets: boolean;
}

/** Ejecuta el check que corresponda al tipo de monitor. Nunca lanza. */
export async function runMonitorCheck(
  monitor: MonitorRow,
  options: RunCheckOptions,
): Promise<CheckOutcome> {
  try {
    switch (monitor.type) {
      case 'http': {
        if (!monitor.url) {
          return { status: 'error', latencyMs: 0, error: 'monitor HTTP sin URL configurada' };
        }
        return await checkHttp(monitor.url, {
          method: monitor.method,
          expectedStatus: monitor.expectedStatus,
          keyword: monitor.keyword,
          timeoutMs: monitor.timeoutMs,
          degradedLatencyMs: monitor.degradedLatencyMs,
          allowPrivateTargets: options.allowPrivateTargets,
        });
      }

      case 'tcp': {
        if (!monitor.host || monitor.port === null) {
          return {
            status: 'error',
            latencyMs: 0,
            error: 'monitor TCP sin host o puerto configurados',
          };
        }
        return await checkTcp(monitor.host, monitor.port, {
          timeoutMs: monitor.timeoutMs,
          degradedLatencyMs: monitor.degradedLatencyMs,
          allowPrivateTargets: options.allowPrivateTargets,
        });
      }

      default:
        return {
          status: 'error',
          latencyMs: 0,
          error: `el worker no sabe ejecutar monitores de tipo «${monitor.type}»`,
        };
    }
  } catch (error) {
    return { status: 'error', latencyMs: 0, error: describeCheckError(error) };
  }
}
