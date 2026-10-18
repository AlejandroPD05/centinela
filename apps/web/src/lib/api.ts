import type { MeResponse, Session } from './types';

// ── Errores ──────────────────────────────────────────────────────────────────

export interface ApiIssue {
  path: Array<string | number>;
  message: string;
}

/** Error de API con el código y el motivo ya masticados para la interfaz. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Traduce los mensajes por defecto de zod (en inglés) a algo legible. */
export function mensajeDeIssue(mensaje: string): string {
  if (/^Invalid URL/i.test(mensaje)) return 'no es una URL válida';
  if (/^Invalid email/i.test(mensaje)) return 'no es un correo válido';
  if (/^Invalid input/i.test(mensaje)) return 'valor no válido';

  const minimo = mensaje.match(/Too small: expected number to be >=([\d.]+)/i);
  if (minimo) return `el mínimo es ${minimo[1]}`;
  const maximo = mensaje.match(/Too big: expected number to be <=([\d.]+)/i);
  if (maximo) return `el máximo es ${maximo[1]}`;

  if (/Too small: expected string to have >=1/i.test(mensaje)) return 'no puede estar vacío';
  if (/Too small/i.test(mensaje)) return 'valor demasiado pequeño';
  if (/Too big/i.test(mensaje)) return 'valor demasiado grande';

  return mensaje;
}

// ── Tokens ───────────────────────────────────────────────────────────────────
// El token de acceso vive en memoria (nunca en el almacén del navegador).
// El de refresco es rotatorio y vive en localStorage: es la única forma de
// sobrevivir a una recarga sin pasar por el formulario otra vez. Al rotar,
// se escribe y las demás pestañas lo adoptan por el evento `storage`.

const REFRESH_STORAGE_KEY = 'centinela.refresh_token';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let onSessionEnded: (() => void) | null = null;

export const tokens = {
  /** Carga lo persistido al arrancar la aplicación. */
  load(): void {
    refreshToken = window.localStorage.getItem(REFRESH_STORAGE_KEY);
  },

  set(session: Pick<Session, 'accessToken' | 'refreshToken'>): void {
    accessToken = session.accessToken;
    refreshToken = session.refreshToken;
    window.localStorage.setItem(REFRESH_STORAGE_KEY, session.refreshToken);
  },

  clear(): void {
    accessToken = null;
    refreshToken = null;
    window.localStorage.removeItem(REFRESH_STORAGE_KEY);
  },

  hasRefresh(): boolean {
    return refreshToken !== null;
  },

  currentRefresh(): string | null {
    return refreshToken;
  },
};

/** La sesión ha muerto (caducó, se cerró en otra pestaña): la UI vuelve a /login. */
export function setSessionEndedHandler(handler: (() => void) | null): void {
  onSessionEnded = handler;
}

/** Otra pestaña rotó (o cerró) la sesión: adoptamos su token. */
export function watchTokenStorage(onAdopt: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== REFRESH_STORAGE_KEY) return;

    refreshToken = event.newValue;
    if (refreshToken === null) {
      accessToken = null;
      onSessionEnded?.();
      return;
    }
    onAdopt();
  };

  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Renueva la sesión. Es una única promesa compartida: si diez peticiones
 * chocan a la vez con un 401, solo una llama a `/auth/refresh` y las demás
 * esperan el mismo resultado (la rotación invalidaría el resto).
 */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    const token = refreshToken;
    if (!token) return false;

    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });

      if (!response.ok) return false;

      const session = (await response.json()) as Session;
      tokens.set(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// ── Cliente ──────────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

/**
 * Petición autenticada a la API. Ante un 401 intenta renovar una vez y repite;
 * si la renovación falla, la sesión se da por terminada y la UI lo sabrá.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return send<T>(path, options, false);
}

async function send<T>(path: string, options: RequestOptions, isRetry: boolean): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetch(`/api${path}${query}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'no hay conexión con la API');
  }

  const isAuthRoute = path.startsWith('/auth/login') || path.startsWith('/auth/refresh');

  if (response.status === 401 && !isAuthRoute) {
    if (!isRetry && (await refreshSession())) {
      return send<T>(path, options, true);
    }

    tokens.clear();
    onSessionEnded?.();
    throw new ApiError(401, 'la sesión ha caducado; vuelve a entrar');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as { error?: string; issues?: ApiIssue[] } | null;
    throw new ApiError(
      response.status,
      body?.error ?? `la API respondió ${response.status}`,
      body?.issues ?? [],
    );
  }

  return payload as T;
}

/** Inicia sesión contra la API y guarda los tokens. */
export async function login(email: string, password: string): Promise<Session> {
  const session = await api<Session>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  tokens.set(session);
  return session;
}

/** Cierra la sesión en el servidor (revoca el refresco) y limpia los tokens. */
export async function logout(): Promise<void> {
  const token = refreshToken;
  tokens.clear();
  if (!token) return;

  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
  } catch {
    // Sin conexión da igual: el token queda revocado al caducar.
  }
}

export function fetchMe(): Promise<MeResponse> {
  return api<MeResponse>('/auth/me');
}
