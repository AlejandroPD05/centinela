import type { CheckStatus, MonitorState } from '@centinela/shared';

/** Aviso en vivo para las páginas de estado (SSE). */
export interface StatusEvent {
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

type Listener = (event: StatusEvent) => void;

/**
 * Buzón en memoria de avisos por espacio de trabajo, para las conexiones SSE
 * de la status page. Vive en el proceso de la API (el worker va embebido), así
 * que publicar y suscribirse es una llamada de función; si algún día corren
 * varias instancias, esto se mudará a `LISTEN/NOTIFY` de PostgreSQL.
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
