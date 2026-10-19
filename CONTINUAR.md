# Continuar con Centinela

Nota de traspaso (19 de octubre de 2026). Cuando no quede nada pendiente,
bórrala sin más.

## Dónde está todo

| Qué                       | Dónde                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Código                    | [github.com/AlejandroPD05/centinela](https://github.com/AlejandroPD05/centinela) (público, CI en verde)                                            |
| Panel en Vercel           | <https://centinela-lake.vercel.app> (proyecto `centinela`, conectado al repositorio, autoDeploy en `main`)                                         |
| Backend en Render         | <https://centinela-90g3.onrender.com/> · status page: <https://centinela-90g3.onrender.com/status/demo>                                            |
| Panel de Render           | <https://dashboard.render.com/web/srv-dbb2olvf3r2c73828kqg> (servicio `centinela`, Frankfurt, plan free)                                           |
| Base de datos             | Neon, proyecto `centinela` (`spring-frog-89581907`), región `aws-eu-central-1`, PostgreSQL 17, cadena directa con `sslmode=require`                |
| Carpeta local             | `C:\Users\OneCu\Desktop\Personal\Yo\Profesional\Proyectos personales\Centinela`                                                                    |
| Ficha en el portfolio     | [alejandropd05.github.io/portfolio](https://alejandropd05.github.io/portfolio/) — tarjeta #011, con enlace a repositorio y demo (commit `2273cbe`) |
| Guía de despliegue        | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                                                                                           |
| Operación (backups, etc.) | [docs/OPERATIONS.md](docs/OPERATIONS.md)                                                                                                           |
| Config del servidor MCP   | Sección «Servidor MCP» del [README](README.md)                                                                                                     |

## Estado

**M0–M10 completos y desplegados.** Motor de checks con guarda SSRF,
histórico contable, incidencias con línea de tiempo, certificados SSL,
heartbeats, avisos (Discord/webhook/email), status page pública con SSE,
insignias SVG, widget embebible, panel de operador, endurecimiento (límites,
watchdog, dead-man), E2E con Playwright, semilla demo de 90 días, servidor MCP
y ficha en el portfolio.

Verificación: 225 pruebas en verde (34 shared + 11 MCP + 180 API), 4 E2E
(Playwright, con servidor víctima) y CI de GitHub en verde.

Despliegue verificado el 19/10/2026:

- `/api/health` y `/api/health/ready` responden 200; worker activo.
- `/status/demo`, `/embed/demo` y `/badge/demo/api-demo.svg` responden 200.
- Login del administrador correcto; espacio `centinela` con rol `admin`.
- Demo sembrada: 7 monitores, 116.647 checks de 90 días y 3 incidencias.
- Panel en Vercel: `/`, `/login`, `/api/*`, `/status/demo`, el badge y las
  fuentes responden 200 a través de los _rewrites_ al backend de Render.
- Vigilancia 24/7 con el plan free: el workflow `Keep-alive`
  (`.github/workflows/keepalive.yml`) hace ping cada 5 minutos y evita que
  Render se duerma. Medido antes del keep-alive: primer acceso tras el letargo,
  22,5 s.
- Usuario administrador: `alejandroprietodiez05@gmail.com` (contraseña
  entregada al desplegar; no se guarda en el repositorio).

## Lo que queda (todo opcional)

### 1. Monitores reales e insignias

El espacio `demo` es solo escaparate. Para vigilar los proyectos de verdad:

1. Crear los monitores en el espacio `centinela` desde el panel o la API
   (`POST /api/monitors`), marcándolos públicos.
2. Su status page quedará en `/status/centinela` y las insignias en
   `/badge/centinela/<monitor>.svg`.
3. Añadir esas insignias a los READMEs de los demás proyectos y, si se quiere,
   el widget: `/embed/centinela`.

### 2. Ideas opcionales

- Canal email con Resend (solo faltan las claves, el código ya está).
- Dominio propio `status.<tu-dominio>` (CNAME en Render, §5 de la guía).
- Pinear el repositorio en el perfil de GitHub.

## Retomar el entorno en local (Windows)

```powershell
# Arranca Docker Desktop si lo tienes cerrado
cd "C:\Users\OneCu\Desktop\Personal\Yo\Profesional\Proyectos personales\Centinela"
docker compose up -d          # PostgreSQL en el puerto 5433
pnpm install                  # solo si cambió el lockfile
pnpm --filter @centinela/api build
pnpm dev                      # API en http://127.0.0.1:4100 y panel en 4101
```

- Datos de demostración: `pnpm db:seed`
  (usuario `alejandro@centinela.local` / `centinela-demo-2026`,
  status page en `http://127.0.0.1:4100/status/demo`).
- Pruebas: `pnpm test` (225) y `pnpm e2e` (4; la primera vez,
  `pnpm e2e:install`).
- Servidor MCP: `pnpm build && pnpm mcp` (config en el README).
- Producción: `render.yaml` con `plan: free` y el panel en Vercel
  (`vercel.json`); Neon ya tiene la base y las migraciones aplicadas.

## Notas de la parada (19/10/2026)

- API, panel, servicio de pruebas y contenedores parados en local. Los datos
  de la demo local siguen en el volumen `centinela-db`.
- Puertos libres: 4100, 4101, 4102, 4200, 4399, 4500 y 5433.
- El único archivo local no versionado del proyecto es `.env` (no se publica;
  la plantilla es `.env.example`).
- La CLI de Render quedó autenticada en este equipo (`render whoami`); la de
  Neon, también (`neon projects list`). Render puede pedir reautenticación al
  caducar el token.
- El despliegue se creó por API, no como Blueprint: los cambios en
  `render.yaml` no alteran el servicio ya creado, pero los pushes a `main` sí
  redeployan con `autoDeploy`.
- Vercel CLI autenticada (`npx vercel whoami` → `alejandropd05`), proyecto
  `centinela` del equipo `me-myself-and-i-8b2d` conectado al repositorio: cada
  push a `main` publica el panel. Los _rewrites_ de `vercel.json` apuntan al
  backend de Render.
- El workflow `Keep-alive` mantiene despierto el backend de Render con un ping
  cada 5 minutos (GitHub Actions, repositorio público: sin coste). Se puede
  lanzar a mano o desactivar desde la pestaña Actions; la URL se cambia con la
  variable de repositorio `CENTINELA_HEALTH_URL`.
