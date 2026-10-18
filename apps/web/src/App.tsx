import { useEffect, useState, type ReactNode } from 'react';

type ApiHealth = { status: string; uptimeSeconds: number };
type LinkState = 'wait' | 'up' | 'down';

const LAMP_CLASS: Record<LinkState, string> = {
  wait: 'bg-ink-dim',
  up: 'bg-lamp-up',
  down: 'bg-lamp-down',
};

const LINK_LABEL: Record<LinkState, string> = {
  wait: 'COMPROBANDO',
  up: 'OPERATIVA',
  down: 'SIN RESPUESTA',
};

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-panel px-5 py-4">
      <dt className="font-data text-[11px] tracking-[0.12em] text-ink-dim">{label}</dt>
      <dd className="mt-2 font-data text-lg">{children}</dd>
    </div>
  );
}

export function App() {
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [link, setLink] = useState<LinkState>('wait');

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        setHealth((await response.json()) as ApiHealth);
        setLink('up');
      } catch {
        if (!controller.signal.aborted) setLink('down');
      }
    };

    void load();
    const timer = window.setInterval(load, 5000);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Franja de peligro: el rojo solo aparece en la marca y en las alertas. */}
      <div className="h-1.5 bg-hazard" aria-hidden="true" />

      <header className="flex flex-wrap items-baseline justify-between gap-2 px-6 py-5 md:px-10">
        <p className="font-display text-2xl tracking-tight">
          CENTINELA<span className="text-hazard">.</span>
        </p>
        <p className="font-data text-xs tracking-[0.12em] text-ink-dim">M0 · BASE OPERATIVA</p>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-12 px-6 py-10 md:px-10">
        <div>
          <h1 className="font-display text-[clamp(2.4rem,8vw,6.5rem)] leading-[0.95] tracking-tight">
            La torre
            <br />
            de vigilancia
            <br />
            ya está en pie.
          </h1>
          <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-dim">
            Uptime, latencia, certificados SSL y heartbeats para los proyectos que despliego. El
            motor de checks y la status page pública están en construcción; la luz de abajo ya es
            real: consulta la API cada cinco segundos.
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-3">
          <Cell label="ESTADO DE LA API">
            <span className="flex items-center gap-2">
              <span className={`lamp lamp--live ${LAMP_CLASS[link]}`} aria-hidden="true" />
              {LINK_LABEL[link]}
            </span>
          </Cell>
          <Cell label="UPTIME DEL PROCESO">
            {health ? formatUptime(health.uptimeSeconds) : '--:--:--'}
          </Cell>
          <Cell label="TRANSPORTE">HTTP · SONDEO 5 S</Cell>
        </dl>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-2 px-6 py-5 font-data text-xs text-ink-dim md:px-10">
        <span>API :4100 · PANEL :4101</span>
        <span>MIT · Alejandro Prieto</span>
      </footer>
    </div>
  );
}
