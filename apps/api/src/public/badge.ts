import { createHash } from 'node:crypto';
import type { MonitorState } from '@centinela/shared';
import { monitorLabel, monitorTone, type LampTone } from './state.js';

/** Relleno del campo de estado: la lámpara en formato plano. */
const FIELD_FILL: Record<LampTone, string> = {
  up: '#46c46a',
  warn: '#e0a32e',
  down: '#e61919',
  off: '#26282c',
};

/** Tinta del texto sobre el campo, con contraste suficiente en cada tono. */
const FIELD_TEXT: Record<LampTone, string> = {
  up: '#0b0c0e',
  warn: '#0b0c0e',
  down: '#ffffff',
  off: '#9a9c99',
};

/** Ancho aproximado de un carácter monoespaciado de 11 px en el SVG. */
const CHAR_WIDTH = 6.6;
const PADDING = 16;
const HEIGHT = 20;
const FONT_STACK =
  "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"; // taste-skill-ignore: el SVG del badge va sin webfonts

export interface BadgeResult {
  svg: string;
  /** ETag fuerte derivado del contenido: mismo resultado, misma caché. */
  etag: string;
}

/**
 * Badge SVG de estado, estilo escudo plano: la etiqueta `centinela` a la
 * izquierda y la palabra del estado sobre el color de la lámpara. Sin JS ni
 * fuentes externas: se pinta en cualquier README.
 */
export function renderBadge(state: MonitorState, paused: boolean): BadgeResult {
  const tone = monitorTone(state, paused);
  const word = monitorLabel(state, paused);
  const label = 'centinela';

  const labelWidth = Math.round(label.length * CHAR_WIDTH) + PADDING;
  const stateWidth = Math.round(word.length * CHAR_WIDTH) + PADDING;
  const width = labelWidth + stateWidth;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="centinela: ${word}">`,
    `<rect width="${labelWidth}" height="${HEIGHT}" fill="#121417"/>`,
    `<rect x="${labelWidth}" width="${stateWidth}" height="${HEIGHT}" fill="${FIELD_FILL[tone]}"/>`,
    `<text x="${labelWidth / 2}" y="14" fill="#9a9c99" font-family="${FONT_STACK}" font-size="11" text-anchor="middle">${label}</text>`,
    `<text x="${labelWidth + stateWidth / 2}" y="14" fill="${FIELD_TEXT[tone]}" font-family="${FONT_STACK}" font-size="11" font-weight="500" text-anchor="middle">${word}</text>`,
    '</svg>',
  ].join('');

  return {
    svg,
    etag: `"${createHash('sha1').update(svg).digest('hex')}"`,
  };
}
