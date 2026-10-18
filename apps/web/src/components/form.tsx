import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

const INPUT_CLASS =
  'w-full border border-line bg-ground px-3 py-2 font-data text-[13px] text-ink outline-none transition-colors focus:border-ink disabled:opacity-50';
const LABEL_CLASS = 'mb-1 block font-data text-[12px] uppercase tracking-[0.12em] text-ink-dim';

interface CampoBase {
  etiqueta: string;
  error?: string | null;
  ayuda?: string;
}

/**
 * Campos con etiqueta real, error anunciado y ayuda asociada por id:
 * navegables con teclado y legibles por lector de pantalla (AA).
 */
export function CampoTexto({
  etiqueta,
  error,
  ayuda,
  className = '',
  ...props
}: CampoBase & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const errorId = `${id}-error`;
  const ayudaId = `${id}-ayuda`;

  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {etiqueta}
      </label>
      <input
        id={id}
        className={`${INPUT_CLASS} ${error ? 'border-hazard-ink' : ''} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [error ? errorId : null, ayuda ? ayudaId : null].filter(Boolean).join(' ') || undefined
        }
        {...props}
      />
      {ayuda && !error ? (
        <p id={ayudaId} className="mt-1 font-data text-[12px] text-ink-dim">
          {ayuda}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 font-data text-[12px] text-hazard-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CampoSelect({
  etiqueta,
  error,
  ayuda,
  children,
  ...props
}: CampoBase & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  const errorId = `${id}-error`;
  const ayudaId = `${id}-ayuda`;

  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {etiqueta}
      </label>
      <select
        id={id}
        className={`${INPUT_CLASS} ${error ? 'border-hazard-ink' : ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [error ? errorId : null, ayuda ? ayudaId : null].filter(Boolean).join(' ') || undefined
        }
        {...props}
      >
        {children}
      </select>
      {ayuda && !error ? (
        <p id={ayudaId} className="mt-1 font-data text-[12px] text-ink-dim">
          {ayuda}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 font-data text-[12px] text-hazard-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CampoCheck({
  etiqueta,
  ayuda,
  ...props
}: CampoBase & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();

  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 size-4 shrink-0 accent-ink" {...props} />
      <div>
        <label htmlFor={id} className="font-data text-[13px] text-ink">
          {etiqueta}
        </label>
        {ayuda ? <p className="mt-0.5 font-data text-[12px] text-ink-dim">{ayuda}</p> : null}
      </div>
    </div>
  );
}
