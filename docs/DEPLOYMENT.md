# Despliegue de Centinela

Producción es un solo proceso: la API con el worker embebido, la status page y
el panel compilado servidos desde el mismo origen. La base de datos vive en
Neon; el servicio, en Render. Esta guía recorre el camino completo y termina
con una lista de comprobación.

## 1. Base de datos en Neon

1. Crea el proyecto en [neon.tech](https://neon.tech) con región **Frankfurt**
   (la misma que el servicio, para que cada check no cruce el Atlántico).
2. Copia la cadena de conexión **directa**, la que no lleva `-pooler`, y añade
   `?sslmode=require`. Ejemplo:
   `postgresql://usuario:clave@ep-algo-123456.eu-central-1.aws.neon.tech/centinela?sslmode=require`
3. ¿Por qué la directa? El puente de avisos en vivo escucha por
   `LISTEN/NOTIFY`, que necesita una sesión propia; el _pooler_ de Neon
   (modo transacción) no lo mantiene. Con una única instancia, la directa va
   sobrada.

## 2. Servicio en Render

### Con el blueprint (recomendado)

El repositorio incluye `render.yaml`. En Render: **New → Blueprint**, conecta
el repositorio y, cuando pida `DATABASE_URL`, pega la cadena de Neon. El
blueprint ya deja configurado:

- Build: `pnpm install --frozen-lockfile && pnpm build && pnpm db:migrate`
  (las migraciones se aplican en cada despliegue; son idempotentes).
- Arranque: `node apps/api/dist/index.js`.
- Salud: `/api/health` (responde 200 incluso `degraded`).
- Región Frankfurt, `autoDeploy` en cada push a `main` y `JWT_SECRET` generado.
- `HOST=0.0.0.0` (Render inyecta `PORT`; no lo definas a mano).
- Plan `free` para probar sin tarjeta. Para vigilancia 24/7, cambia
  `plan: free` por `plan: starter` en `render.yaml` antes de aplicar el
  blueprint (Render pedirá el método de pago).

### Manual (equivalente)

Crea un **Web Service** con runtime Node 24 y estos mandos:

| Ajuste        | Valor                                                             |
| ------------- | ----------------------------------------------------------------- |
| Build Command | `pnpm install --frozen-lockfile && pnpm build && pnpm db:migrate` |
| Start Command | `node apps/api/dist/index.js`                                     |
| Health Check  | `/api/health`                                                     |
| Región        | Frankfurt                                                         |

Variables:

| Variable         | Valor                        | Notas                                    |
| ---------------- | ---------------------------- | ---------------------------------------- |
| `NODE_ENV`       | `production`                 | La API sirve entonces el panel compilado |
| `HOST`           | `0.0.0.0`                    | Render decide el puerto con `PORT`       |
| `DATABASE_URL`   | cadena directa de Neon       | Con `sslmode=require`                    |
| `JWT_SECRET`     | 48+ caracteres aleatorios    | Render puede generarlo                   |
| `WORKER_ENABLED` | `true`                       | Motor de checks en este proceso          |
| `WORKER_TICK_MS` | `1000`                       | Sonda entre ciclos                       |
| `LOG_LEVEL`      | `info`                       | `warn` si prefieres menos ruido          |
| `SELF_PING_URL`  | _(opcional)_ dead-man switch | Ver [OPERATIONS.md](OPERATIONS.md)       |
| `RESEND_API_KEY` | _(opcional)_ canal email     | Con `EMAIL_FROM` verificado              |

No toques `ALLOW_PRIVATE_TARGETS`: en producción la guarda SSRF debe estar
activa (los monitores apuntan a webs públicas).

## 3. Primer acceso

Crea el operador contra la base de Neon, desde tu máquina:

```bash
DATABASE_URL="postgresql://…neon.tech/centinela?sslmode=require" \
  pnpm api:cli create-user --email tu@correo --name Alejandro \
  --workspace centinela --role admin
```

En PowerShell (Windows):

```powershell
$env:DATABASE_URL = "postgresql://…neon.tech/centinela?sslmode=require"
pnpm api:cli create-user --email tu@correo --name Alejandro --workspace centinela --role admin
```

Se te pedirá una contraseña de al menos 8 caracteres. Alternativa sin salir de
Render: **Shell** del servicio y `node apps/api/dist/cli.js create-user …`
(requiere que el disco tenga el build, que lo tiene).

Para una demo pública con datos creíbles, `pnpm api:cli seed-demo` crea el
espacio `demo` (7 monitores e histórico de 90 días). No lo mezcles con tu
espacio real.

Entra en `https://<servicio>.onrender.com/` y accede con esa cuenta.

## 4. Dominio propio

1. Render → Settings → Custom Domain → añade `status.tudominio.com`.
2. En tu DNS, un CNAME al host que indique Render; el certificado se emite solo.
3. Los READMEs usan entonces:
   `https://status.tudominio.com/badge/<espacio>/<monitor>.svg`
4. El widget para incrustar: `https://status.tudominio.com/embed/<espacio>`.

## 5. Despliegues y escala

- Cada push a `main` despliega; las migraciones corren en el build.
- ¿Un despliegue torcido? **Deploys → Rollback** al build anterior.
- Escalar a varias instancias es seguro: el scheduler reclama trabajo con
  `UPDATE … FOR UPDATE SKIP LOCKED` y los avisos en vivo viajan por
  `NOTIFY`, que reparte cada instancia con su `LISTEN`.
- Panel, status page y badges comparten origen: no hay CORS de por medio.

## 6. Operación

- Copias de seguridad y restauración: [OPERATIONS.md](OPERATIONS.md) (Neon
  guarda _point-in-time restore_; el volcado con `pnpm db:backup` es la red
  extra).
- Vigilancia del motor y dead-man switch: [OPERATIONS.md](OPERATIONS.md).
- Avisos: Discord o webhook desde el panel (Canales); email con Resend.

## 7. Lo que no cubre el plan gratuito (honestidad)

- **Render free duerme** el servicio a los ~15 minutos sin tráfico: los checks
  se pausan y una caída nocturna no se detectaría. Para vigilancia 24/7 hace
  falta Starter (~7 $/mes); el plan gratuito sigue valiendo para enseñar la
  status page o probar el despliegue.
- **Neon free** guarda 0,5 GB y un histórico corto de _restore_; de sobra para
  un portfolio, corto si algún día esto crece.

## 8. Lista de comprobación

- [ ] `GET /api/health` responde 200 con `"status":"ok"` y el bloque `worker`
- [ ] `GET /api/health/ready` llega a PostgreSQL
- [ ] La status page carga en HTTPS y el badge SVG responde
- [ ] Login del panel y creación de un monitor de prueba (pasa a `up`)
- [ ] Una caída de mentira (pausa un servicio vigilado) genera incidencia y
      aviso, y la recuperación la cierra
- [ ] `SELF_PING_URL` configurada si usas dead-man switch
- [ ] Copia de seguridad descargada tras la primera semana
