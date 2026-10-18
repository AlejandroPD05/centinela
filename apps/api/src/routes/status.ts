import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import { subscribe } from '../events/hub.js';
import { renderBadge } from '../public/badge.js';
import {
  publicMonitorCard,
  publicMonitorIds,
  publicStatusData,
  publicWorkspaceBySlug,
} from '../public/queries.js';
import { renderEmbedPage, renderNotFoundPage, renderStatusPage } from '../public/view.js';

/**
 * Superficies públicas, fuera del prefijo /api: la status page, su flujo SSE,
 * el widget embebible, los badges SVG y las fuentes self-host.
 */
export function statusRoutes(app: FastifyInstance, database: Database): void {
  app.get('/status/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await publicWorkspaceBySlug(database, slug);

    if (!workspace) {
      return sendHtml(
        request,
        reply,
        renderNotFoundPage(
          'Ese espacio no existe.',
          'Comprueba la dirección: la página de estado se sirve en /status/<espacio>.',
        ),
        { cacheControl: 'no-store', status: 404 },
      );
    }

    const { monitors, incidents } = await publicStatusData(database, workspace.id);
    return sendHtml(
      request,
      reply,
      renderStatusPage({ workspace, monitors, incidents, now: new Date() }),
      {
        cacheControl: 'public, max-age=30, stale-while-revalidate=180',
      },
    );
  });

  // Flujo de avisos del espacio en formato SSE. Solo viajan los monitores
  // públicos: el worker emite para todo el espacio y aquí se filtra.
  app.get('/status/:slug/events', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await publicWorkspaceBySlug(database, slug);
    if (!workspace) return reply.code(404).send({ error: 'espacio no encontrado' });

    const publicIds = new Set(await publicMonitorIds(database, workspace.id));

    reply.hijack();

    const socket = reply.raw;
    socket.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    socket.write('retry: 8000\n\n');
    socket.write(': centinela en escucha\n\n');

    let closed = false;
    let unsubscribe: () => void = () => {};

    unsubscribe = subscribe(workspace.id, (event) => {
      if (closed || !publicIds.has(event.monitorId)) return;
      socket.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      if (!closed) socket.write(': latido\n\n');
    }, 25_000);
    heartbeat.unref();

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    request.raw.on('close', close);
    socket.on('error', close);

    return reply;
  });

  app.get('/embed/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await publicWorkspaceBySlug(database, slug);

    if (!workspace) {
      return sendHtml(
        request,
        reply,
        renderNotFoundPage('Ese espacio no existe.', 'El widget se sirve en /embed/<espacio>.'),
        {
          cacheControl: 'no-store',
          status: 404,
        },
      );
    }

    const { monitors } = await publicStatusData(database, workspace.id);
    reply.header('content-security-policy', 'frame-ancestors *');

    return sendHtml(request, reply, renderEmbedPage({ workspace, monitors, now: new Date() }), {
      cacheControl: 'public, max-age=60, stale-while-revalidate=300',
    });
  });

  app.get('/badge/:slug/:file', async (request, reply) => {
    const { slug, file } = request.params as { slug: string; file: string };
    if (!file.endsWith('.svg')) return reply.code(404).send({ error: 'badge no encontrado' });

    const workspace = await publicWorkspaceBySlug(database, slug);
    if (!workspace) return reply.code(404).send({ error: 'espacio no encontrado' });

    const monitor = await publicMonitorCard(database, workspace.id, file.slice(0, -'.svg'.length));
    if (!monitor) return reply.code(404).send({ error: 'monitor no encontrado' });

    const badge = renderBadge(monitor.state, monitor.paused);
    reply
      .header('etag', badge.etag)
      .header('cache-control', 'public, max-age=60, stale-while-revalidate=600')
      .header('content-type', 'image/svg+xml; charset=utf-8');

    if (request.headers['if-none-match'] === badge.etag) return reply.code(304).send();
    return reply.send(badge.svg);
  });

  app.get('/assets/fonts/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!fontFiles.has(file)) return reply.code(404).send({ error: 'fuente no encontrada' });

    const buffer = await loadFont(file);
    if (!buffer) return reply.code(404).send({ error: 'fuente no encontrada' });

    return reply
      .header('content-type', 'font/woff2')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(buffer);
  });
}

/** Fuentes self-host (subsets latinos, licencia OFL) servidas por la API. */
const fontFiles = new Set([
  'archivo-black-latin.woff2',
  'archivo-400-latin.woff2',
  'ibm-plex-mono-400-latin.woff2',
  'ibm-plex-mono-500-latin.woff2',
]);

const fontsDirectory = fileURLToPath(new URL('../../public/fonts/', import.meta.url));
const fontCache = new Map<string, Buffer>();

async function loadFont(name: string): Promise<Buffer | null> {
  const cached = fontCache.get(name);
  if (cached) return cached;

  try {
    const buffer = await readFile(join(fontsDirectory, name));
    fontCache.set(name, buffer);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Envía HTML con ETag, revalidación y compresión negociada a mano (la API no
 * lleva plugin de compresión y estas páginas son las únicas que lo merecen).
 */
function sendHtml(
  request: FastifyRequest,
  reply: FastifyReply,
  html: string,
  options: { cacheControl: string; status?: number },
): FastifyReply {
  const etag = `"${createHash('sha1').update(html).digest('hex')}"`;

  if (request.headers['if-none-match'] === etag) {
    return reply.code(304).headers({ etag, 'cache-control': options.cacheControl }).send();
  }

  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': options.cacheControl,
    etag,
    vary: 'accept-encoding',
  };

  const accepts = request.headers['accept-encoding'] ?? '';
  if (accepts.includes('br')) {
    return reply
      .code(options.status ?? 200)
      .headers({ ...headers, 'content-encoding': 'br' })
      .send(brotliCompressSync(html));
  }

  if (accepts.includes('gzip')) {
    return reply
      .code(options.status ?? 200)
      .headers({ ...headers, 'content-encoding': 'gzip' })
      .send(gzipSync(html));
  }

  return reply
    .code(options.status ?? 200)
    .headers(headers)
    .send(html);
}
