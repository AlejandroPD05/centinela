import type { ButtonHTMLAttributes, ReactNode } from 'react';

// ── Botones ──────────────────────────────────────────────────────────────────
// Regla de la casa: los elementos interactivos son monocromos (tinta sobre
// sustrato); el color queda para el estado. El paso a «confirmar» sí avisa.

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 border px-3 py-1.5 font-data text-[13px] uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-40';

const BTN_VARIANT = {
  normal: 'border-line text-ink hover:border-ink hover:bg-panel',
  primario: 'border-ink bg-ink text-ground hover:border-white hover:bg-white',
  peligro: 'border-line text-ink hover:border-hazard-ink hover:text-hazard-ink',
  confirmar: 'border-hazard-ink text-hazard-ink hover:bg-hazard-ink hover:text-ground',
} as const;

export type ButtonVariant = keyof typeof BTN_VARIANT;

/** Clases del botón para usar también en `<Link>`. */
export function claseBoton(variant: ButtonVariant = 'normal', extra = ''): string {
  return `${BTN_BASE} ${BTN_VARIANT[variant]} ${extra}`;
}

export function Boton({
  variant = 'normal',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type="button" className={claseBoton(variant, className)} {...props} />;
}

// ── Avisos ───────────────────────────────────────────────────────────────────

export type AvisoTono = 'info' | 'ok' | 'aviso' | 'error';

const AVISO_STYLE: Record<AvisoTono, string> = {
  info: 'border-ink-dim text-ink-dim',
  ok: 'border-lamp-up text-lamp-up',
  aviso: 'border-lamp-warn text-lamp-warn',
  error: 'border-hazard-ink text-hazard-ink',
};

/** Línea de traza: el canal por el que la consola habla de lo que acaba de pasar. */
export function Aviso({
  tono = 'info',
  children,
  className = '',
}: {
  tono?: AvisoTono;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={`border-l-2 py-1 pl-3 font-data text-[13px] ${AVISO_STYLE[tono]} ${className}`}
    >
      {children}
    </p>
  );
}

// ── Estados vacíos y carga ───────────────────────────────────────────────────

export function Vacio({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 font-data text-[13px] uppercase tracking-[0.08em] text-ink-dim">
      {children}
    </p>
  );
}

export function Cargando({ children = 'Cargando…' }: { children?: ReactNode }) {
  return (
    <p aria-live="polite" className="py-2 font-data text-[13px] text-ink-dim">
      {children}
    </p>
  );
}

export function ErrorPanel({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'algo ha ido mal';
  return (
    <Aviso tono="error" className="my-3">
      {message}
    </Aviso>
  );
}

// ── Tablas ───────────────────────────────────────────────────────────────────

export const TH_CLASS =
  'border-b border-line pb-2 pr-4 text-left font-data text-[12px] font-normal uppercase tracking-[0.12em] text-ink-dim';
export const TD_CLASS = 'border-b border-line py-2 pr-4 align-top font-data text-[13px]';

// ── Encabezado de página ─────────────────────────────────────────────────────

export function Cabecera({
  titulo,
  acciones,
  children,
}: {
  titulo: string;
  acciones?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-[26px] leading-tight tracking-tight">{titulo}</h1>
        {acciones ? <div className="flex flex-wrap items-center gap-2">{acciones}</div> : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

/** Bloque de sección con su título en voz de datos. */
export function Seccion({
  titulo,
  acciones,
  children,
  className = '',
}: {
  titulo: string;
  acciones?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mt-8 border-t border-line pt-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-data text-[13px] uppercase tracking-[0.14em] text-ink-dim">{titulo}</h2>
        {acciones ? <div className="flex items-center gap-2">{acciones}</div> : null}
      </div>
      {children}
    </section>
  );
}
