import { useEffect, useState } from 'react';
import { Boton } from './ui';

/**
 * Borrado en dos pasos, sin modales: el primer clic arma, el segundo ejecuta.
 * El armado se deshace solo a los 5 s para que nadie confirme por inercia.
 */
export function ConfirmBoton({
  etiqueta,
  pregunta = 'Confirmar',
  onConfirm,
  pendiente = false,
}: {
  etiqueta: string;
  pregunta?: string;
  onConfirm: () => void;
  pendiente?: boolean;
}) {
  const [armado, setArmado] = useState(false);

  useEffect(() => {
    if (!armado) return;
    const id = window.setTimeout(() => setArmado(false), 5_000);
    return () => window.clearTimeout(id);
  }, [armado]);

  if (!armado) {
    return (
      <Boton variant="peligro" onClick={() => setArmado(true)}>
        {etiqueta}
      </Boton>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Boton variant="confirmar" disabled={pendiente} onClick={onConfirm}>
        {pregunta}
      </Boton>
      <Boton onClick={() => setArmado(false)}>Cancelar</Boton>
    </span>
  );
}
