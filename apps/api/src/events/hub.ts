import type { CheckStatus, MonitorState } from '@centinela/shared';

/** Aviso de un check para las páginas de estado (SSE). */
export interface CheckEvent {
  type: 'check';
  monitorId: string;
  monitorSlug: string;
  /** Estado agregado del monitor tras aplicar el resultado. */
  state: MonitorState;
  /** Resultado del check que provocó el aviso. */
  status: CheckStatus;
  latencyMs: number | null;
  /** `true` si el estado agregado cambió con este check. */
  changed: boolean;
  at: string;
}

/** Despedida: el proceso se apaga y las conexiones SSE cierran en orden. */
export interface ByeEvent {
  type: 'bye';
}

export type StatusEvent = CheckEvent | ByeEvent;

type Listener = (event: StatusEvent) => void;

/**
 * Buzón en memoria de avisos por espacio de trabajo, para las conexiones SSE
 * de la status page. Los procesos no se hablan entre ellos: quien tiene el
 * resultado lo publica en el canal LISTEN/NOTIFY de PostgreSQL (events/bridge)
 * y aquí se reparte lo que llega, venga del worker local o de otra instancia.
 */
const listeners = new Map<string, Set<Listener>>();

/** Suscribe un oyente a los avisos de un espacio; devuelve cómo darse de baja. */
export function subscribe(workspaceId: string, listener: Listener): () => void {
  const set = listeners.get(workspaceId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(workspaceId, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

/** Emite un aviso; un oyente roto jamás tumba al worker. */
export function publish(workspaceId: string, event: StatusEvent): void {
  const set = listeners.get(workspaceId);
  if (!set) return;

  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // Silencio: una página que no sabe escuchar no es problema del vigilado.
    }
  }
}

/** Oyentes activos de un espacio (diagnóstico y tests). */
export function listenerCount(workspaceId: string): number {
  return listeners.get(workspaceId)?.size ?? 0;
}

/** Oyentes activos en todo el proceso, para el tope de conexiones SSE. */
export function totalListenerCount(): number {
  let total = 0;
  for (const set of listeners.values()) total += set.size;
  return total;
}

/** Despide a todos los oyentes (apagado ordenado) y vacía el buzón. */
export function shutdown(): void {
  for (const set of listeners.values()) {
    for (const listener of set) {
      try {
        listener({ type: 'bye' });
      } catch {
        // El proceso se va: un oyente roto ya no importa.
      }
    }
  }

  listeners.clear();
}
