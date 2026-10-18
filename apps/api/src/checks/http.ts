import { CheckTimeoutError, describeCheckError } from './errors.js';
import { safeFetch, SsrfBlockedError } from './ssrf.js';
import type { CheckOutcome } from './types.js';

export interface HttpCheckOptions {
  method: 'GET' | 'HEAD';
  /** Código HTTP exacto que se considera correcto. */
  expectedStatus: number;
  /** Palabra clave obligatoria en el cuerpo (solo con GET). */
  keyword: string | null;
  timeoutMs: number;
  /** Latencia a partir de la cual el servicio queda `degraded`. */
  degradedLatencyMs: number | null;
  allowPrivateTargets: boolean;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 256 * 1024;
const USER_AGENT = 'Centinela/0.1';

/**
 * Ejecuta un check HTTP: sigue redirecciones con la guarda aplicada en cada
 * salto, mide la latencia completa y evalúa código y palabra clave.
 */
export async function checkHttp(rawUrl: string, options: HttpCheckOptions): Promise<CheckOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 'error', latencyMs: 0, error: `URL inválida: ${rawUrl}` };
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CheckTimeoutError()), options.timeoutMs);

  try {
    const response = await fetchFollowingSafeRedirects(url, options, controller.signal);
    const latencyMs = Math.round(performance.now() - startedAt);

    if (response.status !== options.expectedStatus) {
      await discardBody(response);
      return {
        status: 'down',
        latencyMs,
        statusCode: response.status,
        error: `código ${response.status}; se esperaba ${options.expectedStatus}`,
      };
    }

    if (options.keyword !== null && options.method === 'GET') {
      const body = await readBodyCapped(response, MAX_BODY_BYTES);
      if (!body.includes(options.keyword)) {
        return {
          status: 'down',
          latencyMs,
          statusCode: response.status,
          error: `el cuerpo no contiene «${options.keyword}»`,
        };
      }
    } else {
      await discardBody(response);
    }

    const degraded = options.degradedLatencyMs !== null && latencyMs > options.degradedLatencyMs;

    return {
      status: degraded ? 'degraded' : 'up',
      latencyMs,
      statusCode: response.status,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);

    if (error instanceof SsrfBlockedError) {
      return { status: 'error', latencyMs, error: describeCheckError(error) };
    }
    return { status: 'down', latencyMs, error: describeCheckError(error, options.timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sigue hasta 5 redirecciones; la guarda valida cada salto (host y socket). */
async function fetchFollowingSafeRedirects(
  initial: URL,
  options: HttpCheckOptions,
  signal: AbortSignal,
): Promise<Response> {
  let url = initial;
  let method = options.method;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await safeFetch(
      url,
      {
        method,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      },
      { allowPrivateTargets: options.allowPrivateTargets },
    );

    if (!isRedirect(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response; // 3xx sin Location: se evalúa como respuesta final.

    if (hop === MAX_REDIRECTS) {
      await discardBody(response);
      throw new Error(`demasiadas redirecciones (más de ${MAX_REDIRECTS})`);
    }

    await discardBody(response);
    url = new URL(location, url);
    if (response.status === 303) method = 'GET';
  }

  throw new Error('demasiadas redirecciones');
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // El cuerpo ya venía cerrado: da igual.
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}
