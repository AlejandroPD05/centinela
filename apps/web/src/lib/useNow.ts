import { useEffect, useState } from 'react';

/**
 * Reloj compartido del panel: hace repintar los textos relativos («hace 2 min»)
 * sin volver a pedir nada a la API.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
