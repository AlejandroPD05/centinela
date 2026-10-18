# Operaciones de Centinela

Guía para mantener Centinela en marcha: copias de seguridad, vigilancia del
motor, límites y apagado ordenado. Todos los mandos son variables de entorno
(ver `.env.example`); lo que hay aquí se probó contra la base de desarrollo.

## Copias de seguridad

### Qué hace `pnpm db:backup`

- Vuelca la base en formato custom de PostgreSQL (esquema **y** datos,
  restaurable con `pg_restore`) a `backups/centinela_AAAA-MM-DD_hh-mm-ss.dump`.
  La carpeta `backups/` queda fuera de git.
- Rota: conserva las últimas `BACKUP_KEEP` copias (14 por defecto) y borra las
  más viejas.
- Camino de ejecución:
  1. `pg_dump` del PATH, si existe. Sirve igual con Neon que con cualquier
     PostgreSQL (basta `DATABASE_URL`).
  2. Si no hay `pg_dump` pero sí Docker, usa `docker exec` contra el contenedor
     del `docker-compose` (solo válido para la base local).
- Variables: `DATABASE_URL` (o el `.env` del repo), `BACKUP_DIR`,
  `BACKUP_KEEP`, `CENTINELA_DB_CONTAINER` (por defecto `centinela-db-1`).

### Cada cuánto

En producción (Render + Neon), Neon ya hace _point-in-time restore_ de ~24 h en
el plan gratuito. Para conservar más historia, programa el script donde quieras
(tu máquina, el CI) y guarda los volcados fuera del repositorio:

```bash
# Todos los días a las 04:30
30 4 * * * cd ~/Centinela && pnpm db:backup >> backups/backup.log 2>&1
```

### Restaurar

Con cliente PostgreSQL (vale para Neon y para cualquier destino):

```bash
createdb -h localhost -p 5432 centinela_restaurada
pg_restore --no-owner --no-privileges -d postgres://u:p@host:5432/centinela_restaurada \
  backups/centinela_2026-10-18_14-49-14.dump
```

Con la base local del `docker-compose` (sin cliente PostgreSQL instalado):

```bash
docker exec centinela-db-1 psql -U centinela -d centinela -c "create database centinela_restaurada"
docker exec -i centinela-db-1 pg_restore -U centinela -d centinela_restaurada \
  --no-owner --no-privileges < backups/centinela_2026-10-18_14-49-14.dump
```

Restauración parcial (por ejemplo, solo los monitores):

```bash
pg_restore -t monitors --data-only -d <destino> backups/centinela_….dump
```

Después de restaurar: apunta `DATABASE_URL` a la base restaurada, arranca y
comprueba `/api/health/ready` y la status page. En Neon es preferible usar su
propio _Restore_ (crea una rama con el estado anterior); el volcado queda como
red de seguridad para bases y proveedores que no lo ofrezcan.

## Vigilancia del motor y dead-man switch

El motor de checks vive dentro de la API y expone su salud:

- Cada ciclo completado actualiza `cycles`, `lastCycleAt` y `lagSeconds`; el
  bloque `worker` de `/api/health` lo enseña. Con el bucle atascado, `status`
  pasa a `degraded` (la respuesta sigue siendo 200: es una señal, no una caída
  de la API).
- Si el motor lleva más de `WORKER_STALL_SECONDS` (300 por defecto) sin cerrar
  un ciclo, un vigilante externo al bucle lo registra en el log —una sola vez
  por episodio— y avisa cuando se recupera.
- Dead-man switch opcional: si defines `SELF_PING_URL` (por ejemplo un check de
  healthchecks.io), el worker la visita cada `SELF_PING_SECONDS` (300) **desde
  dentro del bucle**: si el proceso muere o el bucle se atasca, dejan de llegar
  avisos y el servicio externo da la alarma. La URL es del operador: no pasa
  por la guarda SSRF a propósito (puede ser una red privada).

| Variable               | Por defecto | Qué controla                                              |
| ---------------------- | ----------- | --------------------------------------------------------- |
| `WORKER_STALL_SECONDS` | `300`       | Segundos sin cerrar un ciclo antes de considerarlo atasco |
| `SELF_PING_URL`        | —           | Check dead-man a visitar (vacío = desactivado)            |
| `SELF_PING_SECONDS`    | `300`       | Cadencia de los avisos dead-man                           |

Montaje con healthchecks.io (o similar): crea el check con periodo
`SELF_PING_SECONDS` y una gracia de al menos el doble, copia la URL de ping y
defínela en el entorno del despliegue. El servicio avisa a tu correo cuando
Centinela calla.

## Límites de peticiones

| Variable                       | Por defecto | Superficie                                                         |
| ------------------------------ | ----------- | ------------------------------------------------------------------ |
| `RATE_LIMIT_PER_MINUTE`        | `600`       | `/api` (por IP; `0` desactiva)                                     |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `300`       | Status page, SSE, badges, widget y fuentes (por IP; `0` desactiva) |
| `HEARTBEAT_LIMIT_PER_MINUTE`   | `120`       | Latidos, por token (`0` desactiva)                                 |
| `LOGIN_ATTEMPTS_PER_MINUTE`    | `10`        | Inicio de sesión, por IP y correo                                  |

- Al superar un límite se responde `429` con `Retry-After` en segundos. El
  log deja un `warning` con la IP y la superficie (`scope`).
- Las conexiones SSE cuentan una vez, al abrirse; hay además un tope de 500
  conexiones vivas por proceso, que responde `503` + `Retry-After` (el navegador
  reintenta solo).
- Cada latido escribe en la base, así que su límite es por token: un script
  descontrolado no puede inundar la serie de un monitor. El límite general por
  IP cubre el resto.
- Si un proxy o CDN compartido (los badges los pide el _camo_ de GitHub) agota
  `PUBLIC_RATE_LIMIT_PER_MINUTE`, súbelo antes que desactivarlo.

## Apagado ordenado

Con `SIGTERM`/`SIGINT` (Render lo manda en cada despliegue), la secuencia es:

1. El worker deja de reclamar monitores y espera a los checks en vuelo.
2. El hub despide las conexiones SSE (`event: bye`) y las cierra: las páginas
   reconectan solas cuando el servicio vuelve.
3. Se cierra el servidor (los sockets keep-alive en reposo se sueltan de
   inmediato), el puente `LISTEN/NOTIFY` y el pool de PostgreSQL.
4. Red de seguridad: si algo se atasca, salida forzada pasados 15 s.

## Runbook

- **`/api/health` con `degraded`** — mira el log: «el motor de checks lleva
  demasiado sin cerrar un ciclo». Suele ser la base lenta o inaccesible; el
  worker reintenta solo y el aviso de recuperación aparece cuando vuelve. Si se
  repite, revisa Neon y el `WORKER_TICK_MS`.
- **Log «puente SSE caído (…); se reintenta»** — la conexión `LISTEN` se perdió;
  se reconecta sola cada 5 s y la status page sigue sirviendo HTML mientras
  tanto. Si es constante, comprueba la cadena de conexión y los límites de
  conexiones de Neon.
- **`429` en el panel o en los badges** — identifica la superficie en el log y
  sube la variable correspondiente (tabla de arriba).
- **`/api/health/ready` con `503`** — PostgreSQL no responde. La API sigue
  viva y el worker reintenta; mira el estado de Neon y las credenciales.
- **La API no arranca** — el log lista las variables mal formadas (zod): casi
  siempre una `DATABASE_URL` incompleta o un `JWT_SECRET` corto.
