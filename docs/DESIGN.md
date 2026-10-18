# Dirección de diseño — Centinela

Documento vivo. Fija la identidad visual **antes** de construir la interfaz
(llega en M5–M6) para que nada derive hacia el aspecto genérico de dashboard SaaS.

## La idea

Centinela es una torre de vigilancia. La interfaz es una **consola de telemetría**:
no un panelito con tarjetas bonitas, sino el pupitre desde el que se leen señales.

El dispositivo central es la **cinta de disponibilidad**: 90 días de servicio como
una tira de sismógrafo, con la aguja del presente al final. El estado se lee como
lámparas de torre: verde fijo (arriba), ámbar intermitente (degradado), rojo firme
(caído), gris apagado (sin datos).

## Método: skills de diseño aplicadas

| Skill                     | Papel en Centinela                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `industrial-brutalist-ui` | **Directriz principal.** Arquetipo "Tactical Telemetry": sustrato oscuro tipo CRT, mono-dominancia en datos, retícula rígida, 90° en todas las esquinas.            |
| `frontend-design`         | Craft y anti-tells: tipografía deliberada (nada de Inter), copy honesto, motion solo donde informa.                                                                 |
| `high-end-visual-design`  | Guardarraíles de rendimiento: animar solo `transform`/`opacity`, sin blur en contenedores de scroll, `z-index` disciplinado.                                        |
| `minimalist-ui`           | Contrapeso de disciplina: color escaso, jerarquía por escala, densidad con calma.                                                                                   |
| `design-taste-frontend`   | Solo para la **status page pública** (página pública real): sus scripts `lint.mjs` / `inspect.mjs` se pasan antes de publicar. No aplica a pantallas de aplicación. |

## Reglas duras (no negociables)

1. **Color = estado.** La única croma de la interfaz son las lámparas de estado.
   El rojo de señal (`#e61919`) queda reservado para la marca y las alertas: los
   elementos interactivos son monocromos (tinta sobre sustrato).
2. **Geometría de 90°**: cero `border-radius`, cero sombras, cero gradientes,
   cero glass/backdrop-blur (salvo overlay fijo si algún día existe).
3. **Líneas estructurales sí**: la retícula visible de 1 px separa zonas
   funcionales. Esto es un plano, no una tarjeta flotante.
4. **Tipografía**: `Archivo Black` para macro (titulares, cifras de uptime);
   `IBM Plex Mono` para todo dato y metadato (etiquetas, series, IDs);
   `Archivo` para texto corrido. Dos familias por pantalla en la práctica.
5. **Uppercase + tracking** solo en metadatos mono; nunca en párrafos.
6. **Densidad bimodal**: bloques de datos apretados junto a vacíos amplios;
   nada de relleno decorativo.
7. **Motion mínimo y funcional**: una animación firma (el barrido de la cinta),
   feedback real en controles, `prefers-reduced-motion` respetado siempre.
8. **Copy de interfaz**: verbos llanos, estado explícito ("sin respuesta desde
   las 04:12"), errores que dicen qué pasó y qué hacer. Sin drama ni halagos.

## Tokens v1

| Token               | Valor         | Uso                                          |
| ------------------- | ------------- | -------------------------------------------- |
| `--color-ground`    | `#0b0c0e`     | Sustrato tipo CRT apagado (nunca negro puro) |
| `--color-panel`     | `#121417`     | Superficie de paneles y celdas               |
| `--color-ink`       | `#e6e6e2`     | Texto principal (blanco fósforo)             |
| `--color-ink-dim`   | `#9a9c99`     | Metadatos y texto secundario                 |
| `--color-line`      | `#26282c`     | Líneas estructurales de 1 px                 |
| `--color-hazard`    | `#e61919`     | Rojo de señal: marca y alertas               |
| `--color-lamp-up`   | `#46c46a`     | Lámpara: servicio arriba                     |
| `--color-lamp-warn` | `#e0a32e`     | Lámpara: degradado                           |
| `--color-lamp-down` | `#e61919`     | Lámpara: caído                               |
| `--font-display`    | Archivo Black | Titulares y cifras grandes                   |
| `--font-body`       | Archivo       | Texto corrido                                |
| `--font-data`       | IBM Plex Mono | Datos, etiquetas, series                     |

## Superficies

1. **Consola de operador** (React + Vite, M6): dashboard, detalle de monitor con
   cinta y percentiles, canales, incidencias, registro de entregas.
2. **Status page pública** (M5): HTML renderizado por la API, sin framework;
   primera pintura sin JavaScript y SSE para lo vivo. Es la superficie donde se
   pasa el gate de `design-taste-frontend`.
3. **Badges SVG** (M5): generados en el servidor, sin JS, con ETag para cachear.
4. **Widget embebible** (M5): la misma status page en modo embed.
5. **Avisos** (M3): notificaciones y emails en texto llano con estas mismas
   reglas de copy.

## Presupuesto de rendimiento

- Status page: HTML + CSS < 15 KB comprimidos, cero JS obligatorio para leer,
  LCP < 1 s en 4G.
- Consola: JS inicial < 140 KB gzip; gráficas SVG propias (sin librería de charts).
- Fuentes: subsetting + self-host antes de publicar; solo los pesos usados.
- Cero imágenes decorativas: la interfaz se dibuja con HTML, CSS y SVG.
