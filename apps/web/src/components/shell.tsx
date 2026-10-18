import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../lib/auth';
import { Boton } from './ui';

const NAV = [
  { to: '/', etiqueta: 'Panel', end: true },
  { to: '/canales', etiqueta: 'Canales' },
  { to: '/incidencias', etiqueta: 'Incidencias' },
  { to: '/entregas', etiqueta: 'Entregas' },
  { to: '/espacio', etiqueta: 'Espacio' },
];

/** Armazón de la consola: barra de mando, contenido y pie. */
export function AppShell() {
  const { user, workspaces, workspace, workspaceId, setWorkspaceId, logout } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#contenido"
        className="absolute top-2 left-2 z-50 -translate-y-24 border border-ink bg-ground px-3 py-2 font-data text-[13px] text-ink focus-visible:translate-y-0"
      >
        Saltar al contenido
      </a>

      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <Link
            to="/"
            className="font-data text-[13px] font-medium tracking-[0.22em] text-hazard-ink uppercase"
          >
            Centinela
          </Link>

          {workspaces.length > 0 ? (
            <div className="flex items-center gap-2">
              <label
                htmlFor="espacio-activo"
                className="font-data text-[12px] tracking-[0.12em] text-ink-dim uppercase"
              >
                Espacio
              </label>
              <select
                id="espacio-activo"
                value={workspaceId ?? ''}
                onChange={(event) => setWorkspaceId(event.target.value)}
                className="border border-line bg-ground px-2 py-1 font-data text-[13px] text-ink outline-none focus:border-ink"
              >
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <nav aria-label="Secciones" className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `border-b-2 pb-0.5 font-data text-[13px] tracking-[0.08em] uppercase transition-colors ${
                    isActive
                      ? 'border-hazard-ink text-ink'
                      : 'border-transparent text-ink-dim hover:text-ink'
                  }`
                }
              >
                {item.etiqueta}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {workspace ? (
              <a
                href={`/status/${workspace.slug}`}
                target="_blank"
                rel="noreferrer"
                className="font-data text-[12px] tracking-[0.08em] text-ink-dim uppercase hover:text-ink"
              >
                Status page ↗
              </a>
            ) : null}
            <span className="hidden font-data text-[12px] text-ink-dim md:inline">
              {user?.email}
            </span>
            <Boton onClick={() => void logout()}>Salir</Boton>
          </div>
        </div>
      </header>

      <main id="contenido" className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-between gap-2 px-4 py-5 font-data text-[12px] text-ink-dim">
          <span>Centinela — consola de operador</span>
          <a href="/api/docs" target="_blank" rel="noreferrer" className="hover:text-ink">
            Documentación de la API ↗
          </a>
        </div>
      </footer>
    </div>
  );
}
