# Centinela

Monitorización de estado para proyectos propios: disponibilidad, latencia,
certificados SSL y heartbeats, con una status page pública que vigila los
despliegues de este portfolio.

> **Estado: M8 — Listo para desplegar.** Pruebas de extremo a extremo con
> Playwright, semilla reproducible, panel servido por la propia API en
> producción y guía de Render + Neon paso a paso. Hoja de ruta completa
> [aquí](#hoja-de-ruta).

## Cómo funciona

El worker (embebido en la API, `WORKER_ENABLED`) reclama cada segundo los
monitores vencidos en PostgreSQL con un único `UPDATE … FOR UPDATE SKIP LOCKED`,
así que escalar a más workers es cuestión de añadir procesos. Cada check se
ejecuta con tiempo máximo y deja su resultado en `check_results`: código,
latencia y motivo del fallo.

- **HTTP**: sigue hasta 5 redirecciones validando cada salto con la guarda,
  exige el código esperado y, si está configurada, una palabra clave en el
  cuerpo; marca `degraded` cuando supera el umbral de latencia.
- **TCP**: mide el tiempo hasta establecer conexión con el puerto.
- **Guarda SSRF**: bucle local, rangos privados, CGNAT y endpoints de metadatos
  (169.254.169.254) quedan bloqueados, incluidas las IPv4 embebidas en IPv6.
  `ALLOW_PRIVATE_TARGETS=true` la desactiva solo para desarrollo local.

Una máquina de estados con umbrales (`confirm_failures` / `confirm_recoveries`)
decide cuándo un monitor pasa a `down` o recupera: un hipo de un segundo no abre
incidencia. El siguiente check se programa con un jitter del ±10 % para evitar
rebaños.

Cada caída confirmada abre una **incidencia** con el motivo del primer fallo; la
recuperación la cierra y ambas quedan apuntadas en su timeline de eventos. La API
resume el histórico por ventanas (`24h`, `7d`, `30d`, `90d`): disponibilidad y
percentiles de latencia (p50/p95/p99) calculados en PostgreSQL, más una serie
diaria rellenada para que la cinta de 90 días no tenga huecos. En los monitores
https se lee además el **certificado TLS** (caducidad y emisor) cada
`SSL_RECHECK_HOURS`, sin validarlo: un certificado caducado o autofirmado es
justo lo que hay que enseñar.

Los **avisos** salen por los canales del espacio (Discord, webhook genérico o
email vía Resend): cada caída, recuperación y cruce de umbral SSL (30, 14, 7, 3
y 1 días) encola una entrega por canal activo. El worker drena la cola con el
mismo patrón `SKIP LOCKED`, con timeout, tres intentos y backoff exponencial
(30 s, 60 s, 120 s); una entrega solo cuenta como enviada cuando el canal
responde, y queda registrada en `deliveries` y en el timeline de su incidencia.
Los **latidos de entrada** (`POST/GET /api/heartbeats/:token`) son un monitor
más: si el ping no llega dentro de periodo + gracia, el worker lo declara
caído, y cada latido entrante cuenta como un check correcto.

El **acceso** se organiza por espacios de trabajo con tres roles: `viewer`
(leer), `editor` (crear y editar) y `admin` (además, miembros y auditoría). Las
sesiones emiten un token de acceso (JWT HS256, una hora) y un token de refresco
opaco que **rota en cada uso** y se guarda por huella en `sessions`; las
contraseñas viven como hash scrypt. Para scripts e integraciones hay **claves de
API** (`cnt_…`, revocables, de solo un vistazo) y toda acción sensible queda en
el **registro de auditoría**. La API se documenta sola en
`/api/openapi.json` con una página legible en `/api/docs`.

La **status page pública** (`/status/:slug`) sale del servidor sin framework:
HTML con la piel de la consola, cinta de 90 días, cifras e incidencias. Sin
JavaScript se lee igual; con SSE (`/status/:slug/events`) los tiempos y las
lámparas se refrescan en vivo, y solo se publican los monitores marcados como
públicos. Los **badges SVG** (`/badge/:slug/:monitor.svg`) van con `ETag` y
caché de un minuto para el README, y el **widget** (`/embed/:slug`) es la misma
página en modo compacto para incrustar en otra web.

El **panel de operador** (React + Vite) es la otra cara: lee los mismos datos
con TanStack Query en ciclos cortos (10–30 s; sin SSE en la consola), pinta la
cinta y la latencia con SVG propio y concentra las acciones —pausar, comprobar
a demanda, editar, probar un canal— sin recargar la página. El panel no
condiciona la vigilancia: los checks y los avisos siguen aunque nadie mire.

## Stack

| Capa         | Elección                                        |
| ------------ | ----------------------------------------------- |
| API y worker | Node + TypeScript, Fastify, Zod, Pino           |
| Datos        | PostgreSQL, Drizzle ORM + drizzle-kit           |
| Panel        | React 19, Vite, TanStack Query, Tailwind CSS v4 |
| Calidad      | Vitest, ESLint + Prettier, GitHub Actions       |
| Despliegue   | Render + Neon (M8)                              |

## Estructura

```
centinela/
├─ apps/
│  ├─ api/        API HTTP + worker (Fastify, Drizzle)
│  ├─ web/        Panel de operador (React + Vite)
│  ├─ mcp/        Servidor MCP para asistentes (solo lectura)
│  └─ e2e/        Pruebas de extremo a extremo (Playwright)
├─ packages/
│  └─ shared/     Tipos, esquemas y lógica pura compartida
├─ docs/
│  └─ DESIGN.md   Dirección de diseño de la interfaz
├─ docker-compose.yml
└─ pnpm-workspace.yaml
```

## Puesta en marcha

Requisitos: Node ≥ 22, pnpm ≥ 10 y Docker en marcha.

```powershell
pnpm install
Copy-Item .env.example .env
docker compose up -d
pnpm db:migrate
pnpm --filter @centinela/api build
pnpm api:cli create-user --email tu@correo.com --password "una-contraseña-larga" --workspace centinela
pnpm dev
```

- API: <http://127.0.0.1:4100/api/health>
- Documentación: <http://127.0.0.1:4100/api/docs>
- Panel: <http://127.0.0.1:4101> (hace proxy de `/api`, `/status`, `/badge`,
  `/embed` y las fuentes hacia la API)

El comando `api:cli create-user` crea el usuario y, si el espacio no existe, lo
crea y te deja como `admin`. Entra con `POST /api/auth/login` o desde el panel.

## Configuración

Todas las variables viven en el `.env` de la raíz (ver [`.env.example`](.env.example)):

| Variable                       | Por defecto          | Qué hace                                             |
| ------------------------------ | -------------------- | ---------------------------------------------------- |
| `HOST` / `PORT`                | `127.0.0.1` / `4100` | Escucha de la API                                    |
| `DATABASE_URL`                 | — (obligatoria)      | Conexión a PostgreSQL                                |
| `LOG_LEVEL`                    | `info`               | Nivel de los logs (pino)                             |
| `WORKER_ENABLED`               | `true`               | Motor de checks embebido en la API                   |
| `WORKER_TICK_MS`               | `1000`               | Sonda entre ciclos cuando no hay trabajo             |
| `WORKER_BATCH_SIZE`            | `10`                 | Monitores reclamados por ciclo                       |
| `WORKER_CONCURRENCY`           | `5`                  | Checks ejecutados en paralelo                        |
| `ALLOW_PRIVATE_TARGETS`        | `false`              | Permite rangos privados (solo desarrollo local)      |
| `JWT_SECRET`                   | — (obligatoria)      | Firma de los tokens de acceso (mínimo 32 caracteres) |
| `ACCESS_TOKEN_TTL_SECONDS`     | `3600`               | Vida del token de acceso (JWT)                       |
| `REFRESH_TOKEN_TTL_DAYS`       | `30`                 | Vida de las sesiones y del token de refresco         |
| `LOGIN_ATTEMPTS_PER_MINUTE`    | `10`                 | Intentos de login por IP y correo                    |
| `RATE_LIMIT_PER_MINUTE`        | `600`                | Peticiones por minuto y por IP en `/api` (`0` off)   |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `300`                | Ídem en status page, badges, widget y fuentes        |
| `HEARTBEAT_LIMIT_PER_MINUTE`   | `120`                | Latidos por minuto y por token (`0` off)             |
| `WORKER_STALL_SECONDS`         | `300`                | Sin cerrar un ciclo: atasco (log + `degraded`)       |
| `SELF_PING_URL`                | — (opcional)         | Check dead-man que el worker visita desde el bucle   |
| `SELF_PING_SECONDS`            | `300`                | Cadencia de los avisos dead-man                      |
| `SSL_RECHECK_HOURS`            | `24`                 | Cada cuántas horas se revisa el certificado TLS      |
| `RESEND_API_KEY`               | — (opcional)         | Clave de Resend para el canal email                  |
| `EMAIL_FROM`                   | — (opcional)         | Remitente verificado en Resend                       |

## Scripts

| Comando                     | Qué hace                                                                          |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                  | Arranca shared en watch, API y panel a la vez                                     |
| `pnpm build`                | Compila todos los paquetes                                                        |
| `pnpm typecheck`            | Comprueba tipos en todo el monorepo                                               |
| `pnpm test`                 | Ejecuta la suite de Vitest                                                        |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                                                 |
| `pnpm db:generate`          | Genera una migración a partir del esquema                                         |
| `pnpm db:migrate`           | Aplica las migraciones pendientes                                                 |
| `pnpm db:studio`            | Abre Drizzle Studio                                                               |
| `pnpm db:backup`            | Volcado restaurable de la base con rotación (ver [operación](docs/OPERATIONS.md)) |
| `pnpm db:seed`              | Recrea la demo pública (espacio `demo`, 90 días de histórico)                     |
| `pnpm e2e`                  | Pruebas de extremo a extremo (Playwright; antes, `pnpm e2e:install`)              |
| `pnpm api:cli`              | Utilidades de operación (p. ej. `create-user`); requiere `pnpm build` previo      |
| `pnpm mcp`                  | Arranca el servidor MCP en modo desarrollo (ver abajo)                            |

## Diseño

La interfaz no es un dashboard genérico: es una consola de telemetría. La
dirección completa (reglas duras, tokens y presupuesto de rendimiento) está en
[docs/DESIGN.md](docs/DESIGN.md).

## Operación

Copias de seguridad y restauración, dead-man switch, límites de peticiones,
apagado ordenado y un runbook para las alertas están en
[docs/OPERATIONS.md](docs/OPERATIONS.md). El despliegue en Render + Neon, paso a
paso, vive en [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Servidor MCP

`apps/mcp` publica el estado y las incidencias como herramientas
[MCP](https://modelcontextprotocol.io) para que un asistente (Claude, Cursor,
cualquier cliente compatible) pueda preguntar «¿qué está caído?» sin abrir el
panel. Es de solo lectura y se autentica con una clave de API.

1. Crea una clave en el panel (**Espacio → Claves**) y compila: `pnpm build`.
2. Apunta tu cliente MCP a `apps/mcp/dist/index.js`:

```json
{
  "mcpServers": {
    "centinela": {
      "command": "node",
      "args": ["C:\\ruta\\a\\Centinela\\apps\\mcp\\dist\\index.js"],
      "env": {
        "CENTINELA_URL": "https://status.tu-dominio.com",
        "CENTINELA_API_KEY": "cnt_…"
      }
    }
  }
}
```

Herramientas disponibles: `estado_de_servicios` (resumen con semáforos,
disponibilidad de 24 h y 7 días e incidencias abiertas), `detalle_de_monitor`
(ficha completa con uptime de 90 días, percentiles de latencia y certificado) y
`listar_incidencias` (causa y duración, con filtro de abiertas). Si solo vigilas
un espacio, `CENTINELA_WORKSPACE` lo fija por defecto.

## Hoja de ruta

- [x] **M0 — Base operativa:** monorepo, API con `/api/health`, esquema y migraciones, CI, primera pantalla
- [x] **M1 — Motor de checks:** HTTP y TCP con guarda SSRF, scheduler `SKIP LOCKED` con jitter, máquina de estados con umbrales, integración real contra PostgreSQL
- [x] **M2 — Histórico:** uptime 24 h / 7 d / 30 d / 90 d, percentiles, incidencias con timeline, estado del certificado SSL
- [x] **M3 — Notificaciones y heartbeats:** Discord, webhook y email; latidos de entrada; reintentos con backoff y registro de entregas
- [x] **M4 — API pública y accesos:** sesiones JWT con refresco rotatorio, roles por espacio, claves de API, OpenAPI servido por la API y auditoría
- [x] **M5 — Status page:** pública con SSE, badges SVG y widget embebible
- [x] **M6 — Panel de operador:** dashboard en vivo, gráficas SVG propias, editores, accesibilidad AA
- [x] **M7 — Endurecimiento:** guarda SSRF en el socket, SSE multi-instancia por `LISTEN/NOTIFY`, límites por IP y por token, watchdog + dead-man switch, copias de seguridad y apagado ordenado ([manual de operación](docs/OPERATIONS.md))
- [x] **M8 — E2E y despliegue:** pruebas de extremo a extremo con servidor víctima y CI, semilla reproducible (`db:seed`), panel servido por la API en producción y guía Render + Neon ([despliegue](docs/DEPLOYMENT.md))
- [x] **M9 — Servidor MCP:** estado e incidencias como herramientas para asistentes (`apps/mcp`, solo lectura y con clave de API)
- [ ] **M10 — Ficha en el portfolio:** captura, tecnologías y demo

## Licencia

[MIT](LICENSE)
