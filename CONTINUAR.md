# Continuar con Centinela

Nota de traspaso (18 de octubre de 2026). Cuando no quede nada pendiente,
bórrala sin más.

## Dónde está todo

| Qué                       | Dónde                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Código                    | [github.com/AlejandroPD05/centinela](https://github.com/AlejandroPD05/centinela) (público, CI en verde)                      |
| Carpeta local             | `C:\Users\OneCu\Desktop\Personal\Yo\Profesional\Proyectos personales\Centinela`                                              |
| Ficha en el portfolio     | [alejandropd05.github.io/portfolio](https://alejandropd05.github.io/portfolio/) — tarjeta #011, ya con enlace al repositorio |
| Guía de despliegue        | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                                                                     |
| Operación (backups, etc.) | [docs/OPERATIONS.md](docs/OPERATIONS.md)                                                                                     |
| Config del servidor MCP   | Sección «Servidor MCP» del [README](README.md)                                                                               |

## Estado

**M0–M10 completos.** Motor de checks con guarda SSRF, histórico contable,
incidencias con línea de tiempo, certificados SSL, heartbeats, avisos
(Discord/webhook/email), status page pública con SSE, insignias SVG, widget
embebible, panel de operador, endurecimiento (límites, watchdog, dead-man),
E2E con Playwright, semilla demo de 90 días, servidor MCP y ficha en el
portfolio.

Verificación: 225 pruebas en verde (34 shared + 11 MCP + 180 API), 4 E2E
(Playwright, con servidor víctima) y CI de GitHub en verde (ejecuciones #1 y #2).

## Lo que queda

### 1. Desplegar en Render + Neon (≈ 5 minutos + crear las cuentas)

Los pasos exactos están en [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). En corto:

1. **Neon**: proyecto en Frankfurt → copia la cadena **directa** (sin
   `-pooler`) y añade `?sslmode=require`.
2. **Render**: New → Blueprint → conecta el repositorio → pega `DATABASE_URL`
   → Apply. El `render.yaml` ya trae build, migraciones, región y
   `JWT_SECRET` automático.
3. **Primer usuario**: comando de la guía (§3, hay variante PowerShell) o
   desde la Shell de Render.
4. Opcional: `pnpm api:cli seed-demo` para una status page de muestra.

### 2. Cuando exista la URL del despliegue

- Añadir `demo` a la ficha del portfolio: hueco marcado con un comentario en
  `js/data/projects.js` del repositorio `portfolio`.
- Poner la URL en el campo **homepage** del repositorio (About).
- Insignias para los READMEs de los demás proyectos:
  `https://<url>/badge/<espacio>/<monitor>.svg`
- Widget embebible: `https://<url>/embed/<espacio>`

### 3. Ideas opcionales

- Canal email con Resend (solo faltan las claves, el código ya está).
- Dominio propio `status.<tu-dominio>` (CNAME en Render, §4 de la guía).
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

## Notas de la parada (18/10/2026)

- Todo parado: API, panel, servicio de pruebas y contenedores. El contenedor
  `centinela-db-1` salió limpio (`Exited 0`) y **los datos de la demo siguen
  en su volumen**: al hacer `docker compose up -d` todo vuelve tal cual.
- Puertos libres: 4100, 4101, 4102, 4200, 4399, 4500 y 5433.
- El único archivo local no versionado del proyecto es `.env` (no se publica;
  la plantilla es `.env.example`).
