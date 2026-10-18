import { useState } from 'react';
import { claseBoton } from './ui';

/** Copia al portapapeles con acuse visible («Copiado») durante dos segundos. */
export function BotonCopiar({ texto, etiqueta = 'Copiar' }: { texto: string; etiqueta?: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 2_000);
    } catch {
      // Sin permiso de portapapeles no hay drama: la URL queda a la vista.
    }
  }

  return (
    <button
      type="button"
      className={claseBoton('normal', 'px-2 py-1 text-[12px]')}
      onClick={() => void copiar()}
    >
      {copiado ? 'Copiado' : etiqueta}
    </button>
  );
}
