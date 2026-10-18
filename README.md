# Centinela

Monitorización de estado para proyectos propios: disponibilidad, latencia,
certificados SSL y heartbeats, con una status page pública que vigila los
despliegues de este portfolio.

> **Estado: M0 — base operativa.** Ya existen el monorepo, la API con validación
> de entorno, el esquema de datos con migraciones y CI; el motor de checks llega
> en M1. Hoja de ruta completa [aquí](#hoja-de-ruta).

## Cómo funcionará

Un scheduler reclama checks vencidos en PostgreSQL (`FOR UPDATE SKIP LOCKED`,
listo para escalar a varios workers), ejecuta el check (HTTP, TCP o heartbeat),
guarda el resultado y aplica una máquina de estados con umbrales de confirmación.
Cuando el estado cambia, abre o cierra una incidencia y encola notificaciones
(Discord, email, webhooks) con reintentos. Todo se ve en el panel de operador y
en la status page pública, que se actualiza en vivo por SSE.

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
│  └─ web/        Panel de operador (React + Vite)
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
pnpm dev
```

- API: <http://127.0.0.1:4100/api/health>
- Panel: <http://127.0.0.1:4101> (hace proxy de `/api` hacia la API)

## Scripts

| Comando                     | Qué hace                                      |
| --------------------------- | --------------------------------------------- |
| `pnpm dev`                  | Arranca shared en watch, API y panel a la vez |
| `pnpm build`                | Compila todos los paquetes                    |
| `pnpm typecheck`            | Comprueba tipos en todo el monorepo           |
| `pnpm test`                 | Ejecuta la suite de Vitest                    |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                             |
| `pnpm db:generate`          | Genera una migración a partir del esquema     |
| `pnpm db:migrate`           | Aplica las migraciones pendientes             |
| `pnpm db:studio`            | Abre Drizzle Studio                           |

## Diseño

La interfaz no es un dashboard genérico: es una consola de telemetría. La
dirección completa (reglas duras, tokens y presupuesto de rendimiento) está en
[docs/DESIGN.md](docs/DESIGN.md).

## Hoja de ruta

- [x] **M0 — Base operativa:** monorepo, API con `/api/health`, esquema y migraciones, CI, primera pantalla
- [ ] **M1 — Motor de checks:** HTTP, TCP y heartbeat; scheduler con `SKIP LOCKED`; retención y rollups
- [ ] **M2 — Histórico:** uptime 24 h / 7 d / 30 d / 90 d, percentiles, incidencias con timeline, avisos SSL
- [ ] **M3 — Notificaciones:** Discord, email y webhooks; cooldowns, reintentos y registro de entregas
- [ ] **M4 — API pública y accesos:** JWT, roles (admin/editor/visor), claves de API, OpenAPI, auditoría
- [ ] **M5 — Status page:** pública con SSE, badges SVG y widget embebible
- [ ] **M6 — Panel de operador:** dashboard en vivo, gráficas SVG propias, editores, accesibilidad AA
- [ ] **M7 — Endurecimiento:** dead-man switch, backups, límites y apagado ordenado
- [ ] **M8 — E2E y despliegue:** Playwright con servidor víctima, seed real, Render + Neon
- [ ] **M9 — Servidor MCP:** consultar estado e incidencias desde un asistente
- [ ] **M10 — Ficha en el portfolio:** captura, tecnologías y demo

## Licencia

[MIT](LICENSE)
