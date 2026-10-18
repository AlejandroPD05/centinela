import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHttp, type HttpCheckOptions } from './http.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');

    switch (url.pathname) {
      case '/ok':
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('centinela ok');
        break;

      case '/slow': {
        const ms = Number(url.searchParams.get('ms') ?? 60);
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('lento pero vivo');
        }, ms);
        break;
      }

      case '/redirect':
        response.writeHead(302, { location: '/ok' });
        response.end();
        break;

      case '/teapot':
        response.writeHead(418, { 'content-type': 'text/plain' });
        response.end('soy una tetera');
        break;

      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('no existe');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const options = (overrides: Partial<HttpCheckOptions> = {}): HttpCheckOptions => ({
  method: 'GET',
  expectedStatus: 200,
  keyword: null,
  timeoutMs: 2000,
  degradedLatencyMs: null,
  allowPrivateTargets: true,
  ...overrides,
});

describe('checkHttp', () => {
  it('un servicio que responde con el código esperado está arriba', async () => {
    const outcome = await checkHttp(`${base}/ok`, options());

    expect(outcome.status).toBe('up');
    expect(outcome.statusCode).toBe(200);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('un código distinto del esperado es una caída, con el código registrado', async () => {
    const outcome = await checkHttp(`${base}/teapot`, options());

    expect(outcome.status).toBe('down');
    expect(outcome.statusCode).toBe(418);
    expect(outcome.error).toContain('418');
  });

  it('si el cuerpo no contiene la palabra clave, es una caída', async () => {
    const hit = await checkHttp(`${base}/ok`, options({ keyword: 'centinela' }));
    const miss = await checkHttp(`${base}/ok`, options({ keyword: 'palabra-ausente' }));

    expect(hit.status).toBe('up');
    expect(miss.status).toBe('down');
    expect(miss.error).toContain('palabra-ausente');
  });

  it('sigue redirecciones (validando cada salto)', async () => {
    const outcome = await checkHttp(`${base}/redirect`, options());

    expect(outcome.status).toBe('up');
    expect(outcome.statusCode).toBe(200);
  });

  it('un servicio lento con umbral de latencia queda degradado', async () => {
    const outcome = await checkHttp(`${base}/slow?ms=60`, options({ degradedLatencyMs: 5 }));

    expect(outcome.status).toBe('degraded');
  });

  it('un servicio rápido no se degrada con un umbral holgado', async () => {
    const outcome = await checkHttp(`${base}/ok`, options({ degradedLatencyMs: 5000 }));

    expect(outcome.status).toBe('up');
  });

  it('si agota el tiempo, queda caído con mensaje explícito', async () => {
    const outcome = await checkHttp(`${base}/slow?ms=500`, options({ timeoutMs: 60 }));

    expect(outcome.status).toBe('down');
    expect(outcome.error).toContain('tiempo agotado');
  });

  it('con la guarda activa, un destino privado ni se toca', async () => {
    const outcome = await checkHttp(`${base}/ok`, options({ allowPrivateTargets: false }));

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('bloqueado');
  });

  it('una URL inválida es un error de configuración, no una caída', async () => {
    const outcome = await checkHttp('no-es-una-url', options());

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('URL inválida');
  });

  it('funciona con método HEAD', async () => {
    const outcome = await checkHttp(`${base}/ok`, options({ method: 'HEAD' }));

    expect(outcome.status).toBe('up');
    expect(outcome.statusCode).toBe(200);
  });
});
