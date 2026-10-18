import {
  INCIDENT_WINDOW_DAYS,
  TAPE_DAYS,
  type PublicIncident,
  type PublicMonitorStatus,
  type PublicWorkspace,
  type TapeDay,
  type UptimeWindowCounts,
} from './queries.js';
import { monitorDataState, monitorLabel, type LampTone } from './state.js';

// ── Formato ──────────────────────────────────────────────────────────────────

/** Escapa texto que viene de la base de datos antes de meterlo en el HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Proporción 0–1 como porcentaje español (`99,98 %`), `—` sin datos. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return '—';
  const pct = ratio * 100;
  if (pct >= 99.995) return '100 %';
  if (pct <= 0.005) return '0,00 %';
  return `${pct.toFixed(2).replace('.', ',')} %`;
}

/** Duración legible: `22 min`, `1 h 22 min`, `2 días`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Tiempo relativo (`hace 3 min`), en la misma escala que usa el script. */
export function formatRelative(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 45) return 'ahora mismo';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;

  const days = Math.round(hours / 24);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Fecha corta en hora local del servidor: `18 oct 04:12`. */
export function formatDateTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${hh}:${mm}`;
}

function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  const monthName = MONTHS[Number(month) - 1] ?? month;
  return `${Number(day)} ${monthName} ${year}`;
}

// ── Agregados del espacio ────────────────────────────────────────────────────

export interface Verdict {
  tone: LampTone;
  text: string;
  /** Lectura corta para el widget embebible. */
  short: string;
}

/** Sentencia global de la status page: el peor estado manda. */
export function workspaceVerdict(monitors: PublicMonitorStatus[]): Verdict {
  if (monitors.length === 0) {
    return { tone: 'off', text: 'Aún no hay servicios públicos.', short: 'sin servicios' };
  }

  const active = monitors.filter((monitor) => !monitor.paused);
  if (active.length === 0) {
    return { tone: 'off', text: 'Todos los servicios están pausados.', short: 'en pausa' };
  }

  const down = active.filter((monitor) => monitor.state === 'down').length;
  const degraded = active.filter((monitor) => monitor.state === 'degraded').length;
  const unknown = active.filter((monitor) => monitor.state === 'pending').length;

  if (down > 0) {
    return {
      tone: 'down',
      text: down === 1 ? 'Un servicio no responde.' : `${down} servicios no responden.`,
      short: 'con problemas',
    };
  }

  if (degraded > 0) {
    return {
      tone: 'warn',
      text:
        degraded === 1 ? 'Un servicio está degradado.' : `${degraded} servicios están degradados.`,
      short: 'degradado',
    };
  }

  if (unknown === active.length) {
    return { tone: 'off', text: 'Sin datos todavía.', short: 'sin datos' };
  }

  if (unknown > 0) {
    return {
      tone: 'off',
      text: `Faltan datos de ${unknown} ${unknown === 1 ? 'servicio' : 'servicios'}.`,
      short: 'sin datos',
    };
  }

  return { tone: 'up', text: 'Todos los servicios responden.', short: 'todo en orden' };
}

/** Suma de contadores por ventana: la cifra agregada pesa por checks, no por monitores. */
export function aggregateUptime(monitors: PublicMonitorStatus[]): {
  day: UptimeWindowCounts;
  week: UptimeWindowCounts;
  month: UptimeWindowCounts;
} {
  const sum = (pick: (monitor: PublicMonitorStatus) => UptimeWindowCounts): UptimeWindowCounts => {
    let available = 0;
    let total = 0;
    for (const monitor of monitors) {
      available += pick(monitor).available;
      total += pick(monitor).total;
    }
    return { available, total, ratio: total === 0 ? null : available / total };
  };

  return {
    day: sum((monitor) => monitor.uptime.day),
    week: sum((monitor) => monitor.uptime.week),
    month: sum((monitor) => monitor.uptime.month),
  };
}

/** Cinta agregada del espacio: el peor resultado del día entre los monitores activos. */
export function aggregateTape(monitors: PublicMonitorStatus[]): TapeDay[] {
  const first = monitors[0];
  const tape: TapeDay[] = [];

  for (let index = 0; index < TAPE_DAYS; index++) {
    let total = 0;
    let available = 0;
    let degraded = 0;
    let down = 0;

    for (const monitor of monitors) {
      const day = monitor.tape[index];
      if (!day) continue;
      total += day.total;
      available += day.available;
      degraded += day.degraded;
      down += day.down;
    }

    tape.push({
      date: first?.tape[index]?.date ?? '',
      total,
      available,
      availability: total === 0 ? null : available / total,
      degraded,
      down,
      tone: total === 0 ? 'nodata' : down > 0 ? 'down' : degraded > 0 ? 'warn' : 'up',
    });
  }

  return tape;
}

// ── Cinta ────────────────────────────────────────────────────────────────────

function tapeSummary(tape: TapeDay[]): string {
  const up = tape.filter((day) => day.tone === 'up').length;
  const warn = tape.filter((day) => day.tone === 'warn').length;
  const down = tape.filter((day) => day.tone === 'down').length;
  const nodata = tape.filter((day) => day.tone === 'nodata').length;

  const parts = [`${up} ${up === 1 ? 'día correcto' : 'días correctos'}`];
  if (warn > 0) parts.push(`${warn} con lentitud`);
  if (down > 0) parts.push(`${down} con fallos`);
  if (nodata > 0) parts.push(`${nodata} sin datos`);

  return `Cinta de los últimos ${tape.length} días: ${parts.join(', ')}.`;
}

function renderTape(tape: TapeDay[], options: { hero?: boolean } = {}): string {
  const cells = tape
    .map((day, index) => {
      const title =
        day.tone === 'nodata'
          ? `${formatDateKey(day.date)} · sin datos`
          : `${formatDateKey(day.date)} · ${formatPercent(day.availability)} (${day.total} ${day.total === 1 ? 'check' : 'checks'})`;
      const live = index === tape.length - 1 ? ' data-live' : '';
      return `<i data-tone="${day.tone}"${live} title="${escapeHtml(title)}" style="--i:${index}"></i>`;
    })
    .join('');

  return `<div class="cinta${options.hero ? ' cinta--hero' : ''}" role="img" aria-label="${escapeHtml(tapeSummary(tape))}">${cells}</div>`;
}

// ── Piezas de página ─────────────────────────────────────────────────────────

function sortMonitors(monitors: PublicMonitorStatus[]): PublicMonitorStatus[] {
  return [...monitors].sort(
    (a, b) => Number(a.paused) - Number(b.paused) || a.name.localeCompare(b.name, 'es'),
  );
}

function latestCheck(monitors: PublicMonitorStatus[]): Date | null {
  let latest: Date | null = null;
  for (const monitor of monitors) {
    if (!monitor.lastCheckAt) continue;
    const at = new Date(monitor.lastCheckAt);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

function renderCifras(totals: {
  day: UptimeWindowCounts;
  week: UptimeWindowCounts;
  month: UptimeWindowCounts;
}): string {
  return `<dl class="cifras">
      <div><dt class="meta">24 h</dt><dd>${formatPercent(totals.day.ratio)}</dd></div>
      <div><dt class="meta">7 días</dt><dd>${formatPercent(totals.week.ratio)}</dd></div>
      <div><dt class="meta">30 días</dt><dd>${formatPercent(totals.month.ratio)}</dd></div>
    </dl>`;
}

function renderMonitorAlert(monitor: PublicMonitorStatus, now: Date): string {
  if (monitor.paused || !monitor.lastStateChangeAt) return '';
  if (monitor.state !== 'down' && monitor.state !== 'degraded') return '';

  const since = new Date(monitor.lastStateChangeAt);
  const elapsed = formatDuration(Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000)));
  const when = formatDateTime(since);

  if (monitor.state === 'down') {
    return `<p class="servicio-alerta">Sin respuesta desde el ${when} · ${elapsed}</p>`;
  }

  return `<p class="servicio-alerta" data-alerta="warn">Responde con lentitud desde el ${when} · ${elapsed}</p>`;
}

function renderMonitorRow(monitor: PublicMonitorStatus, now: Date): string {
  const label = monitorLabel(monitor.state, monitor.paused);
  const lastCheck = monitor.lastCheckAt;
  const ultima = lastCheck
    ? `comprobado <time data-ultimo datetime="${lastCheck}" data-at="${lastCheck}">${formatRelative(new Date(lastCheck), now)}</time>`
    : 'sin comprobar todavía';

  return [
    `<li class="servicio" data-monitor="${escapeHtml(monitor.id)}" data-state="${monitorDataState(monitor.state, monitor.paused)}">`,
    '<div class="servicio-nombre">',
    '<span class="lampara" aria-hidden="true"></span>',
    `<h3>${escapeHtml(monitor.name)}</h3>`,
    monitor.target ? `<span class="servicio-host mono">${escapeHtml(monitor.target)}</span>` : '',
    '</div>',
    '<div class="servicio-datos">',
    `<span class="servicio-pct">${formatPercent(monitor.uptime.month.ratio)}</span>`,
    '<span class="meta">30 días</span>',
    '</div>',
    renderTape(monitor.tape),
    '<p class="servicio-pie">',
    `<strong data-estado-texto>${label}</strong>`,
    `<span>24 h ${formatPercent(monitor.uptime.day.ratio)}</span>`,
    `<span>${ultima}</span>`,
    '</p>',
    renderMonitorAlert(monitor, now),
    '</li>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function renderIncidents(incidents: PublicIncident[]): string {
  if (incidents.length === 0) {
    return `<p class="vacio">Sin incidencias en los últimos ${INCIDENT_WINDOW_DAYS} días.</p>`;
  }

  const items = incidents
    .map((incident) => {
      const start = formatDateTime(new Date(incident.startedAt));
      const end = incident.resolvedAt
        ? `<time datetime="${incident.resolvedAt}">${formatDateTime(new Date(incident.resolvedAt))}</time>`
        : 'en curso';
      const open = incident.resolvedAt === null ? ' data-abierta="si"' : '';
      const cause = incident.cause ? `<span> · ${escapeHtml(incident.cause)}</span>` : '';

      return [
        `<li class="incidencia"${open}>`,
        '<div>',
        `<p class="incidencia-nombre">${escapeHtml(incident.monitorName)}</p>`,
        `<p class="meta incidencia-cuando"><time datetime="${incident.startedAt}">${start}</time> → ${end}${cause}</p>`,
        '</div>',
        `<span class="incidencia-duracion">${formatDuration(incident.durationSeconds)}</span>`,
        '</li>',
      ].join('\n');
    })
    .join('\n');

  return `<ol class="lista-incidencias">${items}</ol>`;
}

function verdictDataState(tone: LampTone): string {
  switch (tone) {
    case 'up':
      return 'up';
    case 'warn':
      return 'degraded';
    case 'down':
      return 'down';
    case 'off':
      return 'pending';
  }
}

// ── Páginas ──────────────────────────────────────────────────────────────────

export interface StatusPageInput {
  workspace: PublicWorkspace;
  monitors: PublicMonitorStatus[];
  incidents: PublicIncident[];
  now: Date;
}

/** Status page completa: veredicto, cinta de 90 días, cifras e incidencias. */
export function renderStatusPage({ workspace, monitors, incidents, now }: StatusPageInput): string {
  const active = monitors.filter((monitor) => !monitor.paused);
  const pausedCount = monitors.length - active.length;
  const verdict = workspaceVerdict(monitors);
  const ordered = sortMonitors(monitors);
  const latest = latestCheck(monitors);
  const slug = escapeHtml(workspace.slug);
  const badgeExample = ordered.find((monitor) => !monitor.paused) ?? ordered[0];

  const meta = [`${monitors.length} ${monitors.length === 1 ? 'servicio' : 'servicios'}`];
  if (pausedCount > 0) meta.push(`${pausedCount} ${pausedCount === 1 ? 'pausado' : 'pausados'}`);

  const actualizado = latest
    ? `actualizado <time data-actualizado data-at="${latest.toISOString()}">${formatRelative(latest, now)}</time>`
    : 'sin datos todavía';

  const hero = active.length > 0 ? renderTape(aggregateTape(active), { hero: true }) : '';
  const cifras = active.length > 0 ? renderCifras(aggregateUptime(active)) : '';

  const servicios =
    ordered.length === 0
      ? '<p class="vacio">Este espacio todavía no publica servicios.</p>'
      : `<ol class="lista-servicios">${ordered.map((monitor) => renderMonitorRow(monitor, now)).join('\n')}</ol>`;

  const incidencias =
    monitors.length > 0
      ? `<section class="seccion">
      <div class="seccion-cabecera">
        <h2>Incidencias</h2>
        <span class="meta">Últimos ${INCIDENT_WINDOW_DAYS} días</span>
      </div>
      ${renderIncidents(incidents)}
    </section>`
      : '';

  const enlacesPie = badgeExample
    ? `<p>Badge: <a href="/badge/${slug}/${escapeHtml(badgeExample.slug)}.svg">/badge/${slug}/${escapeHtml(badgeExample.slug)}.svg</a> · Widget: <a href="/embed/${slug}">/embed/${slug}</a></p>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(workspace.name)} · estado de los servicios · Centinela</title>
<meta name="description" content="${escapeHtml(`Estado en vivo de los servicios de ${workspace.name}: disponibilidad de los últimos 90 días, latencia e incidencias.`)}">
<meta name="theme-color" content="#0b0c0e">
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="/assets/fonts/archivo-black-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/ibm-plex-mono-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<style>${STATUS_CSS}</style>
</head>
<body data-eventos="/status/${slug}/events">
<a class="salto" href="#cintas">Ir a los servicios</a>
<header class="barra">
  <div class="lienzo barra-fila">
    <p class="marca">Centinela</p>
    <p class="meta barra-espacio">${escapeHtml(workspace.name)}</p>
    <a class="meta" href="/api/docs">API</a>
  </div>
</header>
<main class="lienzo">
  <section class="tablero">
    <h1 class="veredicto" data-tono="${verdict.tone}">${escapeHtml(verdict.text)}</h1>
    <p class="meta sub">${escapeHtml(meta.join(' · '))} · ${actualizado}</p>
    ${hero}
    ${cifras}
  </section>
  <section class="seccion" id="cintas">
    <div class="seccion-cabecera">
      <h2>Los servicios</h2>
      <span class="meta">${monitors.length === 1 ? '1 monitor' : `${monitors.length} monitores`}</span>
    </div>
    ${servicios}
  </section>
  ${incidencias}
</main>
<footer class="pie">
  <div class="lienzo">
    <p class="pie-marca" aria-hidden="true">Centinela</p>
    <div class="meta pie-lineas">
      <p>Vigilancia propia de uptime, latencia, SSL y latidos.</p>
      <p>Estado en vivo por SSE · sin cookies ni rastreadores · <a href="/api/docs">API</a></p>
      ${enlacesPie}
    </div>
  </div>
</footer>
<script>${LIVE_SCRIPT}</script>
</body>
</html>`;
}

export interface EmbedPageInput {
  workspace: PublicWorkspace;
  monitors: PublicMonitorStatus[];
  now: Date;
}

/** Widget compacto para incrustar en una web (misma cinta, sin incidencias). */
export function renderEmbedPage({ workspace, monitors, now }: EmbedPageInput): string {
  const verdict = workspaceVerdict(monitors);
  const ordered = sortMonitors(monitors);
  const latest = latestCheck(monitors);
  const slug = escapeHtml(workspace.slug);

  const rows = ordered
    .map((monitor) =>
      [
        `<li class="embed-fila" data-monitor="${escapeHtml(monitor.id)}" data-state="${monitorDataState(monitor.state, monitor.paused)}">`,
        '<span class="lampara" aria-hidden="true"></span>',
        `<span class="embed-nombre">${escapeHtml(monitor.name)}</span>`,
        renderTape(monitor.tape),
        `<span class="pct mono">${formatPercent(monitor.uptime.month.ratio)}</span>`,
        '</li>',
      ].join('\n'),
    )
    .join('\n');

  const cuerpo =
    ordered.length === 0
      ? '<p class="embed-vacio">Sin servicios públicos todavía.</p>'
      : `<ul class="embed-lista">${rows}</ul>`;

  const sello = latest
    ? `<time data-actualizado data-at="${latest.toISOString()}">${formatRelative(latest, now)}</time>`
    : 'sin datos';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(workspace.name)} · estado · Centinela</title>
<meta name="theme-color" content="#0b0c0e">
<link rel="icon" href="${FAVICON}">
<style>${STATUS_CSS}</style>
</head>
<body class="embed" data-eventos="/status/${slug}/events">
<main class="embed-caja">
  <header class="embed-cabecera" data-state="${verdictDataState(verdict.tone)}">
    <span class="lampara" aria-hidden="true"></span>
    <h1>${escapeHtml(workspace.name)}</h1>
    <p class="meta">${escapeHtml(verdict.short)}</p>
  </header>
  ${cuerpo}
  <footer class="embed-pie">
    <span class="meta">${monitors.length} ${monitors.length === 1 ? 'servicio' : 'servicios'} · ${sello}</span>
    <a class="meta" href="/status/${slug}">ver completo</a>
  </footer>
</main>
<script>${LIVE_SCRIPT}</script>
</body>
</html>`;
}

/** Página 404 mínima, con la misma piel. */
export function renderNotFoundPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Centinela</title>
<link rel="icon" href="${FAVICON}">
<style>${STATUS_CSS}</style>
</head>
<body>
<header class="barra">
  <div class="lienzo barra-fila">
    <p class="marca">Centinela</p>
    <a class="meta" href="/api/docs">API</a>
  </div>
</header>
<main class="lienzo">
  <section class="tablero">
    <h1 class="veredicto" data-tono="off">${escapeHtml(title)}</h1>
    <p class="meta sub">${escapeHtml(detail)}</p>
  </section>
</main>
</body>
</html>`;
}

// ── Recursos incrustados ─────────────────────────────────────────────────────

const FAVICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='#0b0c0e'/><rect x='4.5' y='4.5' width='7' height='7' fill='#e61919'/></svg>`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

/**
 * Lo único que ejecuta la status page: escuchar los avisos SSE y refrescar los
 * tiempos relativos. Sin esto, la página se lee igual: solo se queda quieta.
 */
const LIVE_SCRIPT = `(function () {
  var url = document.body.getAttribute('data-eventos');
  var palabras = { up: 'responde', degraded: 'degradado', down: 'sin respuesta', pending: 'sin datos', paused: 'pausado' };
  var tonosCheck = { up: 'up', degraded: 'warn', down: 'down', error: 'down' };

  function hace(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'ahora mismo';
    var m = Math.round(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    var d = Math.round(h / 24);
    return 'hace ' + d + (d === 1 ? ' día' : ' días');
  }

  function pintarTiempos() {
    var ahora = Date.now();
    var nodos = document.querySelectorAll('time[data-at]');
    for (var i = 0; i < nodos.length; i++) {
      var t = Date.parse(nodos[i].getAttribute('data-at'));
      if (!isNaN(t)) nodos[i].textContent = hace(ahora - t);
    }
  }

  function aplicar(d) {
    var fila = document.querySelector('[data-monitor="' + d.monitorId + '"]');
    if (fila) {
      fila.setAttribute('data-state', d.state);
      var texto = fila.querySelector('[data-estado-texto]');
      if (texto && palabras[d.state]) texto.textContent = palabras[d.state];
      var ultimo = fila.querySelector('[data-ultimo]');
      if (ultimo && d.at) {
        ultimo.setAttribute('data-at', d.at);
        ultimo.textContent = hace(Date.now() - Date.parse(d.at));
      }
    }
    if (tonosCheck[d.status]) {
      var agujas = document.querySelectorAll('.cinta--hero [data-live], [data-monitor="' + d.monitorId + '"] [data-live]');
      for (var i = 0; i < agujas.length; i++) agujas[i].setAttribute('data-tone', tonosCheck[d.status]);
    }
    var sello = document.querySelector('[data-actualizado]');
    if (sello && d.at) sello.setAttribute('data-at', d.at);
  }

  if (url && 'EventSource' in window) {
    var fuente = new EventSource(url);
    fuente.onmessage = function (evento) {
      try { aplicar(JSON.parse(evento.data)); } catch (e) {}
    };
  }

  pintarTiempos();
  setInterval(pintarTiempos, 30000);
})();`;

/**
 * Piel compartida por status page, widget y 404. Consola de telemetría:
 * sustrato CRT apagado, retícula de 1 px y color reservado a los estados.
 */
const STATUS_CSS = `@font-face{font-family:'Archivo Black';font-style:normal;font-weight:400;font-display:swap;src:url('/assets/fonts/archivo-black-latin.woff2') format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:400;font-display:swap;src:url('/assets/fonts/archivo-400-latin.woff2') format('woff2')}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:400;font-display:swap;src:url('/assets/fonts/ibm-plex-mono-400-latin.woff2') format('woff2')}/*taste-skill-ignore*/
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url('/assets/fonts/ibm-plex-mono-500-latin.woff2') format('woff2')}/*taste-skill-ignore*/
:root{--ground:#0b0c0e;--panel:#121417;--ink:#e6e6e2;--dim:#9a9c99;--line:#26282c;--hazard:#e61919;--hazard-ink:#f53b2f;--lamp-up:#46c46a;--lamp-warn:#e0a32e;--lamp-down:var(--hazard);--rule:1px solid var(--line);--font-display:'Archivo Black','Arial Black',system-ui,sans-serif;--font-body:'Archivo',system-ui,sans-serif;--font-data:'IBM Plex Mono',ui-monospace,'Cascadia Mono',Consolas,monospace}/*taste-skill-ignore: mono-dominancia en datos y retícula de 1 px — reglas duras de docs/DESIGN.md*/
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font-body);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3,p,dl,dd,dt,ol,ul{margin:0;padding:0}
ol,ul{list-style:none}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
a:hover{text-decoration-color:var(--ink)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
::selection{background:var(--ink);color:var(--ground)}
.mono{font-family:var(--font-data)}
.meta{font-family:var(--font-data);font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.lienzo{max-width:1060px;margin:0 auto;padding-left:20px;padding-right:20px}
.salto{position:absolute;left:-9999px;top:0;background:var(--ink);color:var(--ground);padding:8px 14px;font-family:var(--font-data);font-size:13px}
.salto:focus{left:0;z-index:10}
.barra{border-bottom:var(--rule)}
.barra-fila{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:6px 18px;padding-top:12px;padding-bottom:12px}
.barra-espacio{margin-left:auto}
.marca{color:var(--hazard-ink);font-family:var(--font-data);font-weight:500;font-size:13px;letter-spacing:.22em;text-transform:uppercase}
.tablero{padding:44px 0 36px}
.veredicto{font-family:var(--font-display);font-size:clamp(34px,6.5vw,76px);line-height:1.04;letter-spacing:-.015em;max-width:20ch;margin-bottom:10px}
.veredicto[data-tono='up']{color:var(--lamp-up)}
.veredicto[data-tono='warn']{color:var(--lamp-warn)}
.veredicto[data-tono='down']{color:var(--lamp-down)}
.veredicto[data-tono='off']{color:var(--dim)}
.sub{margin-bottom:26px}
.cinta{display:flex;gap:2px;height:20px}
.cinta i{display:block;flex:1 1 0;min-width:2px;background:#1d2023;animation-name:escribir;animation-duration:.45s;animation-timing-function:ease-out;animation-fill-mode:both;animation-delay:calc(var(--i)*6ms)}
.cinta i[data-tone='up']{background:#2f7a46}
.cinta i[data-tone='warn']{background:var(--lamp-warn)}
.cinta i[data-tone='down']{background:var(--lamp-down)}
.cinta i[data-tone='nodata']{background:#1d2023}
.cinta--hero{height:38px}
.cinta [data-live]{animation-name:escribir,aguja;animation-duration:.45s,2.6s;animation-timing-function:ease-out,ease-in-out;animation-iteration-count:1,infinite;animation-fill-mode:both,none;animation-delay:calc(var(--i)*6ms),1.2s}
.cinta i[data-tone='up'][data-live]{background:var(--lamp-up)}
@keyframes escribir{from{opacity:.12}to{opacity:1}}
@keyframes aguja{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes parpadeo{0%,100%{opacity:1}50%{opacity:.4}}
.cifras{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:var(--rule);margin-top:30px}
.cifras>div{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 10px;padding:16px 16px 0 0}
.cifras>div+div{border-left:var(--rule);padding-left:18px}
.cifras dd{font-family:var(--font-display);font-size:clamp(20px,2.6vw,30px);line-height:1.1}
.seccion{padding:40px 0 8px}
.seccion-cabecera{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:10px;border-bottom:var(--rule)}
.seccion h2{font-family:var(--font-display);font-size:20px;letter-spacing:.01em}
.vacio{padding:18px 0;border-bottom:var(--rule);color:var(--dim)}
.servicio{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:20px;row-gap:10px;padding:16px 0;border-bottom:var(--rule)}
.servicio:hover{background:var(--panel)}
.servicio-nombre{display:flex;align-items:baseline;gap:10px;min-width:0}
.servicio-nombre h3{font-size:17px;font-weight:400;letter-spacing:.01em}
.servicio-host{font-size:13px;color:var(--dim);overflow-wrap:anywhere}
.servicio-datos{display:flex;align-items:baseline;gap:12px}
.servicio-pct{font-family:var(--font-display);font-size:22px}
.servicio .cinta{grid-column:1/-1;height:16px}
.servicio-pie{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 16px;font-family:var(--font-data);font-size:13px;color:var(--dim)}
.servicio-pie strong{font-weight:500;color:var(--ink)}
.servicio-alerta{grid-column:1/-1;font-family:var(--font-data);font-size:13px;color:var(--hazard-ink)}
.servicio-alerta[data-alerta='warn']{color:var(--lamp-warn)}
.lampara{width:10px;height:10px;flex:none;background:#3a3d41}
[data-state='up'] .lampara{background:var(--lamp-up)}
[data-state='degraded'] .lampara{background:var(--lamp-warn);animation:parpadeo 2s ease-in-out infinite}
[data-state='down'] .lampara{background:var(--lamp-down)}
.incidencia{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:20px;padding:14px 0;border-bottom:var(--rule)}
.incidencia-nombre{font-size:16px}
.incidencia-cuando{margin-top:2px}
.incidencia-cuando span{overflow-wrap:anywhere}
.incidencia-duracion{font-family:var(--font-data);font-size:13px;text-align:right}
.incidencia[data-abierta] .incidencia-duracion{color:var(--hazard-ink)}
.pie{border-top:var(--rule);margin-top:120px}
.pie-marca{font-family:var(--font-display);font-size:clamp(52px,13vw,132px);line-height:.82;letter-spacing:-.02em;padding:34px 0 26px}
.pie-lineas{display:grid;gap:6px;padding-bottom:30px}
.pie-lineas a{color:var(--dim)}
.embed-caja{padding:14px 16px 10px}
body.embed{min-width:280px}
.embed-cabecera{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:var(--rule)}
.embed-cabecera h1{font-family:var(--font-display);font-size:15px;line-height:1.15}
.embed-cabecera .meta{margin-left:auto;text-align:right}
.embed-fila{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:var(--rule)}
.embed-nombre{flex:0 0 32%;min-width:70px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.embed-fila .cinta{flex:1 1 auto;height:12px;gap:1px;min-width:60px}
.embed-fila .cinta i{animation-delay:calc(var(--i)*3ms)}
.embed-fila .pct{flex:none;width:72px;text-align:right;font-size:12px;color:var(--dim)}
.embed-vacio{padding:12px 0 6px;color:var(--dim);font-size:14px}
.embed-pie{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px;padding:9px 0 0}
.embed-pie .meta{font-size:12px}
.embed-pie a{color:var(--dim)}
@media (max-width:640px){.tablero{padding:32px 0 26px}.cifras>div{padding-right:8px}.cifras>div+div{padding-left:12px}.servicio-pct{font-size:18px}.pie-marca{padding-top:26px;padding-bottom:20px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;
