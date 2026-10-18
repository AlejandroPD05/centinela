import { describe, expect, it } from 'vitest';
import {
  listenerCount,
  publish,
  shutdown,
  subscribe,
  totalListenerCount,
  type StatusEvent,
} from '../events/hub.js';
import { renderBadge } from './badge.js';
import { TAPE_DAYS, type PublicMonitorStatus, type TapeDay } from './queries.js';
import {
  aggregateTape,
  aggregateUptime,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  renderEmbedPage,
  renderNotFoundPage,
  renderStatusPage,
  workspaceVerdict,
} from './view.js';

const NOW = new Date('2026-10-18T12:00:00Z');

function makeTape(tone: TapeDay['tone'] = 'up'): TapeDay[] {
  return Array.from({ length: TAPE_DAYS }, (_, index) => ({
    date: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}`,
    total: tone === 'nodata' ? 0 : 288,
    available: tone === 'nodata' ? 0 : 288,
    availability: tone === 'nodata' ? null : 1,
    degraded: tone === 'warn' ? 1 : 0,
    down: tone === 'down' ? 1 : 0,
    tone,
  }));
}

function makeMonitor(overrides: Partial<PublicMonitorStatus> = {}): PublicMonitorStatus {
  return {
    id: 'mon-1',
    name: 'Web pública',
    slug: 'web',
    type: 'http',
    target: 'example.com',
    state: 'up',
    paused: false,
    lastCheckAt: '2026-10-18T11:58:00.000Z',
    lastStateChangeAt: '2026-10-18T09:00:00.000Z',
    uptime: {
      day: { available: 288, total: 288, ratio: 1 },
      week: { available: 2016, total: 2016, ratio: 1 },
      month: { available: 8640, total: 8640, ratio: 1 },
    },
    tape: makeTape(),
    ...overrides,
  };
}

const WORKSPACE = { id: 'ws-1', name: 'Aurora', slug: 'aurora' };

describe('formato', () => {
  it('escapa el HTML de los datos', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'más'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;más&#39;',
    );
  });

  it('formatea porcentajes en español', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(0.9998)).toBe('99,98 %');
    expect(formatPercent(0.5)).toBe('50,00 %');
  });

  it('formatea duraciones', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(3_600)).toBe('1 h');
    expect(formatDuration(5_400)).toBe('1 h 30 min');
    expect(formatDuration(90_000)).toBe('25 h');
    expect(formatDuration(172_800)).toBe('2 días');
  });

  it('formatea tiempos relativos', () => {
    expect(formatRelative(new Date(NOW.getTime() - 10_000), NOW)).toBe('ahora mismo');
    expect(formatRelative(new Date(NOW.getTime() - 180_000), NOW)).toBe('hace 3 min');
    expect(formatRelative(new Date(NOW.getTime() - 7_200_000), NOW)).toBe('hace 2 h');
    expect(formatRelative(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe('hace 3 días');
  });

  it('formatea la fecha corta', () => {
    expect(formatDateTime(new Date('2026-10-18T04:12:00'))).toBe('18 oct 04:12');
  });
});

describe('veredicto del espacio', () => {
  it('sin servicios públicos', () => {
    expect(workspaceVerdict([])).toEqual({
      tone: 'off',
      text: 'Aún no hay servicios públicos.',
      short: 'sin servicios',
    });
  });

  it('todo responde', () => {
    const verdict = workspaceVerdict([makeMonitor()]);
    expect(verdict.tone).toBe('up');
    expect(verdict.text).toBe('Todos los servicios responden.');
  });

  it('una caída manda sobre el resto', () => {
    const verdict = workspaceVerdict([makeMonitor(), makeMonitor({ id: 'mon-2', state: 'down' })]);
    expect(verdict.tone).toBe('down');
    expect(verdict.text).toBe('Un servicio no responde.');
  });

  it('varias caídas pluralizan', () => {
    const verdict = workspaceVerdict([
      makeMonitor({ id: 'a', state: 'down' }),
      makeMonitor({ id: 'b', state: 'down' }),
    ]);
    expect(verdict.text).toBe('2 servicios no responden.');
  });

  it('los degradados avisan sin alarmar', () => {
    const verdict = workspaceVerdict([makeMonitor({ state: 'degraded' })]);
    expect(verdict.tone).toBe('warn');
    expect(verdict.text).toBe('Un servicio está degradado.');
  });

  it('todo pausado no se disfraza de caída', () => {
    const verdict = workspaceVerdict([makeMonitor({ paused: true })]);
    expect(verdict.tone).toBe('off');
    expect(verdict.text).toBe('Todos los servicios están pausados.');
  });

  it('sin datos todavía', () => {
    const verdict = workspaceVerdict([makeMonitor({ state: 'pending' })]);
    expect(verdict.tone).toBe('off');
    expect(verdict.text).toBe('Sin datos todavía.');
  });
});

describe('agregados', () => {
  it('la cifra pesa por checks, no por monitores', () => {
    const totals = aggregateUptime([
      makeMonitor({
        uptime: {
          day: { available: 1, total: 1, ratio: 1 },
          week: { available: 0, total: 0, ratio: null },
          month: { available: 0, total: 0, ratio: null },
        },
      }),
      makeMonitor({
        id: 'mon-2',
        uptime: {
          day: { available: 1, total: 999, ratio: 1 / 999 },
          week: { available: 0, total: 0, ratio: null },
          month: { available: 0, total: 0, ratio: null },
        },
      }),
    ]);

    expect(totals.day.total).toBe(1000);
    expect(totals.day.available).toBe(2);
    expect(totals.day.ratio).toBeCloseTo(0.002);
    expect(totals.week.ratio).toBeNull();
  });

  it('la cinta agregada usa el peor resultado del día', () => {
    const a = makeMonitor({ tape: makeTape('nodata') });
    const b = makeMonitor({ id: 'mon-2', tape: makeTape('nodata') });

    a.tape[0] = { ...a.tape[0]!, tone: 'up', total: 288, available: 288, availability: 1 };
    a.tape[1] = { ...a.tape[1]!, tone: 'down', total: 288, available: 286, down: 2 };
    b.tape[1] = { ...b.tape[1]!, tone: 'up', total: 288, available: 288, availability: 1 };
    b.tape[2] = { ...b.tape[2]!, tone: 'warn', total: 288, available: 288, degraded: 1 };

    const tape = aggregateTape([a, b]);
    expect(tape).toHaveLength(TAPE_DAYS);
    expect(tape[0]?.tone).toBe('up');
    expect(tape[1]?.tone).toBe('down');
    expect(tape[2]?.tone).toBe('warn');
    expect(tape[3]?.tone).toBe('nodata');
  });
});

describe('render', () => {
  it('la status page escapa el contenido y pinta las dos cintas', () => {
    const html = renderStatusPage({
      workspace: WORKSPACE,
      monitors: [makeMonitor({ name: '<script>alert(1)</script>' })],
      incidents: [],
      now: NOW,
    });

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(/data-tone="/g)).toHaveLength(2 * TAPE_DAYS);
    expect(html).toContain('class="cinta cinta--hero"');
    expect(html).toContain('Sin incidencias en los últimos 30 días.');
    expect(html).toContain('/badge/aurora/web.svg');
    expect(html).toContain('data-eventos="/status/aurora/events"');
  });

  it('la status page avisa de las incidencias abiertas', () => {
    const html = renderStatusPage({
      workspace: WORKSPACE,
      monitors: [makeMonitor({ state: 'down' })],
      incidents: [
        {
          id: 'inc-1',
          monitorId: 'mon-1',
          monitorName: 'Web pública',
          monitorSlug: 'web',
          startedAt: '2026-10-18T10:00:00.000Z',
          resolvedAt: null,
          durationSeconds: 7_200,
          cause: 'conexión rechazada',
        },
      ],
      now: NOW,
    });

    expect(html).toContain('Un servicio no responde.');
    expect(html).toContain('conexión rechazada');
    expect(html).toContain('data-abierta="si"');
    expect(html).toContain('en curso');
    expect(html).toContain('Sin respuesta desde el');
  });

  it('sin monitores queda un estado vacío honesto', () => {
    const html = renderStatusPage({
      workspace: WORKSPACE,
      monitors: [],
      incidents: [],
      now: NOW,
    });

    expect(html).toContain('Aún no hay servicios públicos.');
    expect(html).toContain('Este espacio todavía no publica servicios.');
    expect(html).not.toContain('class="cinta cinta--hero"');
  });

  it('el widget es compacto y no se indexa', () => {
    const html = renderEmbedPage({
      workspace: WORKSPACE,
      monitors: [makeMonitor(), makeMonitor({ id: 'mon-2', name: 'API', state: 'degraded' })],
      now: NOW,
    });

    expect(html).toContain('noindex');
    expect(html).toContain('ver completo');
    expect(html).toContain('/status/aurora');
    expect(html).not.toContain('class="cinta cinta--hero"');
    expect(html.match(/data-tone="/g)).toHaveLength(2 * TAPE_DAYS);
  });

  it('la página 404 lleva la misma piel', () => {
    const html = renderNotFoundPage('Ese espacio no existe.', 'Comprueba la dirección.');
    expect(html).toContain('Ese espacio no existe.');
    expect(html).toContain('Comprueba la dirección.');
    expect(html).toContain('class="marca"');
    expect(html).toContain('--hazard-ink');
    expect(html).toContain('noindex');
  });
});

describe('badges', () => {
  it('un badge de servicio arriba es estable y verde', () => {
    const first = renderBadge('up', false);
    const second = renderBadge('up', false);

    expect(first.etag).toBe(second.etag);
    expect(first.svg).toContain('#46c46a');
    expect(first.svg).toContain('responde');
    expect(first.svg).toContain('centinela');
  });

  it('cada estado cambia el color, la palabra y el ETag', () => {
    const up = renderBadge('up', false);
    const down = renderBadge('down', false);
    const warn = renderBadge('degraded', false);
    const off = renderBadge('pending', true);

    expect(down.etag).not.toBe(up.etag);
    expect(down.svg).toContain('sin respuesta');
    expect(down.svg).toContain('#e61919');
    expect(warn.svg).toContain('#e0a32e');
    expect(off.svg).toContain('pausado');
    expect(off.svg).toContain('#26282c');
  });
});

describe('buzón de avisos', () => {
  const event: StatusEvent = {
    type: 'check',
    monitorId: 'mon-1',
    monitorSlug: 'web',
    state: 'up',
    status: 'up',
    latencyMs: 12,
    changed: false,
    at: '2026-10-18T10:00:00.000Z',
  };

  it('reparte por espacio y da de baja al oyente', () => {
    const received: StatusEvent[] = [];
    const unsubscribe = subscribe('espacio-1', (item) => received.push(item));
    expect(listenerCount('espacio-1')).toBe(1);

    publish('espacio-1', event);
    expect(received).toHaveLength(1);

    publish('espacio-2', event);
    expect(received).toHaveLength(1);

    unsubscribe();
    expect(listenerCount('espacio-1')).toBe(0);
  });

  it('un oyente roto no tumba a los demás', () => {
    const received: string[] = [];
    const bad = subscribe('espacio-3', () => {
      throw new Error('roto');
    });
    const good = subscribe('espacio-3', () => received.push('ok'));

    publish('espacio-3', event);
    expect(received).toEqual(['ok']);

    bad();
    good();
  });

  it('shutdown() despide a todos los oyentes con un bye y vacía el buzón', () => {
    const received: StatusEvent[] = [];
    subscribe('espacio-4', (item) => received.push(item));
    subscribe('espacio-5', (item) => received.push(item));
    expect(totalListenerCount()).toBe(2);

    shutdown();

    expect(received).toEqual([{ type: 'bye' }, { type: 'bye' }]);
    expect(totalListenerCount()).toBe(0);
  });
});
