import type { FastifyInstance } from 'fastify';

/**
 * Documento OpenAPI 3.1 escrito a mano y servido por la propia API en
 * `/api/openapi.json`, más una página HTML mínima en `/api/docs`. No se
 * genera automáticamente: es corto, estable y honesto (`x-access` resume
 * quién puede llamar a cada ruta).
 */
interface EndpointDoc {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  access: 'pública' | 'autenticada' | 'token de latido';
}

const endpoints: EndpointDoc[] = [
  // Sistema
  {
    method: 'get',
    path: '/',
    tag: 'sistema',
    summary: 'Presentación de la API (nombre y versión)',
    access: 'pública',
  },
  {
    method: 'get',
    path: '/health',
    tag: 'sistema',
    summary: 'Liveness: ¿el proceso respira?',
    access: 'pública',
  },
  {
    method: 'get',
    path: '/health/ready',
    tag: 'sistema',
    summary: 'Readiness: ¿PostgreSQL responde?',
    access: 'pública',
  },
  {
    method: 'get',
    path: '/openapi.json',
    tag: 'sistema',
    summary: 'Este documento OpenAPI 3.1',
    access: 'pública',
  },
  {
    method: 'get',
    path: '/docs',
    tag: 'sistema',
    summary: 'Página HTML con el índice de endpoints',
    access: 'pública',
  },

  // Accesos
  {
    method: 'post',
    path: '/auth/login',
    tag: 'auth',
    summary: 'Inicia sesión y devuelve tokens de acceso y refresco',
    access: 'pública',
  },
  {
    method: 'post',
    path: '/auth/refresh',
    tag: 'auth',
    summary: 'Rota la sesión y emite tokens nuevos',
    access: 'pública',
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'auth',
    summary: 'Revoca la sesión a partir del token de refresco',
    access: 'pública',
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'auth',
    summary: 'Quién soy y qué espacios tengo',
    access: 'autenticada',
  },

  // Monitores
  {
    method: 'get',
    path: '/monitors',
    tag: 'monitores',
    summary: 'Lista los monitores de tus espacios (filtra por workspaceId)',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/monitors',
    tag: 'monitores',
    summary: 'Crea un monitor (http, tcp o heartbeat)',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/monitors/{id}',
    tag: 'monitores',
    summary: 'Detalle de un monitor',
    access: 'autenticada',
  },
  {
    method: 'patch',
    path: '/monitors/{id}',
    tag: 'monitores',
    summary: 'Cambia la configuración de un monitor',
    access: 'autenticada',
  },
  {
    method: 'delete',
    path: '/monitors/{id}',
    tag: 'monitores',
    summary: 'Borra un monitor y su histórico',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/monitors/{id}/check',
    tag: 'monitores',
    summary: 'Programa un check inmediato',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/monitors/{id}/uptime',
    tag: 'monitores',
    summary: 'Disponibilidad y percentiles (window=24h|7d|30d|90d)',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/monitors/{id}/history',
    tag: 'monitores',
    summary: 'Serie diaria de los últimos días (days)',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/monitors/{id}/incidents',
    tag: 'monitores',
    summary: 'Incidencias con su timeline',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/monitors/{id}/checks',
    tag: 'monitores',
    summary: 'Últimos checks crudos (limit=1..200)',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/incidents',
    tag: 'incidencias',
    summary: 'Incidencias de tus espacios, la más reciente primero',
    access: 'autenticada',
  },

  // Latidos
  {
    method: 'post',
    path: '/heartbeats/{token}',
    tag: 'latidos',
    summary: 'Latido de un monitor heartbeat',
    access: 'token de latido',
  },
  {
    method: 'get',
    path: '/heartbeats/{token}',
    tag: 'latidos',
    summary: 'Latido vía GET (para pingers simples)',
    access: 'token de latido',
  },

  // Canales
  {
    method: 'get',
    path: '/channels',
    tag: 'canales',
    summary: 'Lista los canales de aviso de tus espacios',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/channels',
    tag: 'canales',
    summary: 'Crea un canal (discord, webhook o email)',
    access: 'autenticada',
  },
  {
    method: 'patch',
    path: '/channels/{id}',
    tag: 'canales',
    summary: 'Renombra, habilita o recalibra un canal',
    access: 'autenticada',
  },
  {
    method: 'delete',
    path: '/channels/{id}',
    tag: 'canales',
    summary: 'Borra un canal',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/channels/{id}/test',
    tag: 'canales',
    summary: 'Envía un aviso de prueba por el canal',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/deliveries',
    tag: 'avisos',
    summary: 'Registro de entregas de avisos (status, limit)',
    access: 'autenticada',
  },

  // Espacios
  {
    method: 'get',
    path: '/workspaces',
    tag: 'espacios',
    summary: 'Tus espacios de trabajo con tu rol',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/workspaces',
    tag: 'espacios',
    summary: 'Crea un espacio (serás su administración)',
    access: 'autenticada',
  },
  {
    method: 'get',
    path: '/workspaces/{id}/members',
    tag: 'espacios',
    summary: 'Miembros del espacio',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/workspaces/{id}/members',
    tag: 'espacios',
    summary: 'Añade un miembro por correo (admin)',
    access: 'autenticada',
  },
  {
    method: 'patch',
    path: '/workspaces/{id}/members/{userId}',
    tag: 'espacios',
    summary: 'Cambia el rol de un miembro (admin)',
    access: 'autenticada',
  },
  {
    method: 'delete',
    path: '/workspaces/{id}/members/{userId}',
    tag: 'espacios',
    summary: 'Quita a un miembro (admin)',
    access: 'autenticada',
  },

  // Claves de API
  {
    method: 'get',
    path: '/api-keys',
    tag: 'claves de API',
    summary: 'Tus claves de API (sin el secreto)',
    access: 'autenticada',
  },
  {
    method: 'post',
    path: '/api-keys',
    tag: 'claves de API',
    summary: 'Crea una clave; el secreto solo se muestra aquí',
    access: 'autenticada',
  },
  {
    method: 'delete',
    path: '/api-keys/{id}',
    tag: 'claves de API',
    summary: 'Revoca una clave',
    access: 'autenticada',
  },

  // Auditoría
  {
    method: 'get',
    path: '/audit',
    tag: 'auditoría',
    summary: 'Rastro de acciones: lo tuyo y lo de tus espacios administrados',
    access: 'autenticada',
  },
];

const tagDescriptions: Array<{ name: string; description: string }> = [
  { name: 'sistema', description: 'Salud, documentación y metadatos de la API.' },
  { name: 'auth', description: 'Sesiones: inicio, refresco, cierre y perfil.' },
  { name: 'monitores', description: 'Alta, configuración, estado, uptime e incidencias.' },
  {
    name: 'latidos',
    description: 'Pings de los monitores heartbeat; el token de la URL es la credencial.',
  },
  { name: 'canales', description: 'Canales de aviso (Discord, webhook, email) por espacio.' },
  { name: 'espacios', description: 'Espacios de trabajo y sus miembros.' },
  { name: 'claves de API', description: 'Credenciales personales para scripts e integraciones.' },
  { name: 'auditoría', description: 'Rastro de acciones sobre la plataforma.' },
  {
    name: 'incidencias',
    description: 'Incidencias de tus espacios sin timeline: lectura rápida del panel.',
  },
  { name: 'avisos', description: 'Entregas de avisos: estado, intentos y motivo del fallo.' },
];

/** Construye el documento OpenAPI a partir del registro de endpoints. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of endpoints) {
    const operations = (paths[endpoint.path] ??= {});
    operations[endpoint.method] = {
      tags: [endpoint.tag],
      summary: endpoint.summary,
      'x-access': endpoint.access,
      ...(endpoint.access === 'autenticada' ? { security: [{ bearerAuth: [] }] } : {}),
      responses: {
        '200': { description: 'Respuesta correcta' },
        ...(endpoint.access === 'autenticada'
          ? { '401': { description: 'Falta el token o no es válido' } }
          : {}),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API de Centinela',
      version: '0.1.0',
      description:
        'API de la plataforma de monitorización Centinela: monitores, histórico, avisos, latidos y accesos. Autentica con `Authorization: Bearer`, usando el token de acceso de una sesión o una clave de API `cnt_…`.',
    },
    servers: [{ url: '/api' }],
    tags: tagDescriptions,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Token de acceso (JWT) de una sesión, o clave de API `cnt_…`.',
        },
      },
    },
    paths,
  };
}

/** Página de documentación: sustrato oscuro, mono, sin dependencias externas. */
const DOCS_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API de Centinela</title>
<style>
  :root {
    --ground: #0b0c0e;
    --panel: #121417;
    --ink: #e6e6e2;
    --ink-dim: #9a9c99;
    --line: #26282c;
    --hazard: #e61919;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--ground);
    color: var(--ink);
    font-family: ui-monospace, "IBM Plex Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: 1.55;
    padding: 48px 20px 96px;
  }
  header, main { max-width: 960px; margin: 0 auto; }
  .marca { color: var(--hazard); letter-spacing: 0.32em; font-size: 12px; margin: 0 0 10px; }
  h1 {
    font-family: system-ui, sans-serif;
    font-weight: 900;
    text-transform: uppercase;
    font-size: 42px;
    letter-spacing: 0.02em;
    margin: 0;
  }
  .nota { color: var(--ink-dim); margin: 12px 0 0; font-size: 13px; }
  section { margin-top: 52px; }
  h2 {
    font-size: 12px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.28em;
    color: var(--ink-dim);
    border-bottom: 1px solid var(--line);
    padding-bottom: 8px;
    margin: 0 0 2px;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: grid;
    grid-template-columns: 56px minmax(150px, 320px) 1fr auto;
    gap: 16px;
    align-items: baseline;
    padding: 10px 12px;
    margin: 0 -12px;
    border-bottom: 1px solid var(--line);
  }
  li:hover { background: var(--panel); }
  .metodo { font-size: 11px; letter-spacing: 0.14em; color: var(--ink-dim); }
  .ruta { color: var(--ink); }
  .resumen { color: var(--ink-dim); }
  .acceso {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-dim);
    border: 1px solid var(--line);
    padding: 2px 8px;
    white-space: nowrap;
  }
  .acceso.abierta { color: var(--ink); }
  @media (max-width: 720px) {
    li { grid-template-columns: 56px 1fr; }
    .resumen, .acceso { grid-column: 2; }
  }
</style>
</head>
<body>
<header>
  <p class="marca">CENTINELA</p>
  <h1>API</h1>
  <p class="nota" id="nota">cargando el documento…</p>
</header>
<main id="salida"></main>
<script>
(function () {
  var orden = ['sistema', 'auth', 'monitores', 'latidos', 'canales', 'espacios', 'claves de API', 'auditoría'];
  var salida = document.getElementById('salida');
  var nota = document.getElementById('nota');

  fetch('/api/openapi.json')
    .then(function (response) {
      if (!response.ok) throw new Error('estado ' + response.status);
      return response.json();
    })
    .then(function (doc) {
      var grupos = new Map();

      Object.keys(doc.paths).forEach(function (ruta) {
        var operaciones = doc.paths[ruta];
        Object.keys(operaciones).forEach(function (metodo) {
          var operacion = operaciones[metodo];
          var etiqueta = (operacion.tags && operacion.tags[0]) || 'otros';
          if (!grupos.has(etiqueta)) grupos.set(etiqueta, []);
          grupos.get(etiqueta).push({
            metodo: metodo.toUpperCase(),
            ruta: ruta,
            resumen: operacion.summary || '',
            acceso: operacion['x-access'] || ''
          });
        });
      });

      var nombres = orden.filter(function (nombre) { return grupos.has(nombre); });
      Array.from(grupos.keys()).forEach(function (nombre) {
        if (orden.indexOf(nombre) === -1) nombres.push(nombre);
      });

      nombres.forEach(function (nombre) {
        var seccion = document.createElement('section');

        var titulo = document.createElement('h2');
        titulo.textContent = nombre;
        seccion.appendChild(titulo);

        var lista = document.createElement('ul');
        grupos.get(nombre).forEach(function (punto) {
          var fila = document.createElement('li');

          var metodo = document.createElement('span');
          metodo.className = 'metodo';
          metodo.textContent = punto.metodo;

          var ruta = document.createElement('code');
          ruta.className = 'ruta';
          ruta.textContent = punto.ruta;

          var resumen = document.createElement('span');
          resumen.className = 'resumen';
          resumen.textContent = punto.resumen;

          var acceso = document.createElement('span');
          acceso.className = 'acceso' + (punto.acceso === 'pública' ? ' abierta' : '');
          acceso.textContent = punto.acceso;

          fila.appendChild(metodo);
          fila.appendChild(ruta);
          fila.appendChild(resumen);
          fila.appendChild(acceso);
          lista.appendChild(fila);
        });

        seccion.appendChild(lista);
        salida.appendChild(seccion);
      });

      nota.textContent = doc.info.title + ' v' + doc.info.version + ' · OpenAPI ' + doc.openapi;
    })
    .catch(function () {
      nota.textContent = 'no se pudo cargar el documento OpenAPI';
    });
})();
</script>
</body>
</html>
`;

/** Rutas de documentación: el documento JSON y la página que lo pinta. */
export function openApiRoutes(app: FastifyInstance): void {
  app.get('/openapi.json', async () => buildOpenApiDocument());

  app.get('/docs', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(DOCS_HTML);
  });
}
