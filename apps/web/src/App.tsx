import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/shell';
import { Cargando } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { CanalesPage } from './pages/Canales';
import { DashboardPage } from './pages/Dashboard';
import { EntregasPage } from './pages/Entregas';
import { EspacioPage } from './pages/Espacio';
import { IncidenciasPage } from './pages/Incidencias';
import { LoginPage } from './pages/Login';
import { MonitorDetailPage } from './pages/MonitorDetail';
import { MonitorFormPage } from './pages/MonitorForm';

/** Puerta del panel: sin sesión restaurada no se pinta nada de dentro. */
function Protegido() {
  const { ready, user } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Cargando>Cargando la consola…</Cargando>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace state={{ desde: location.pathname }} />;

  return <AppShell />;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<Protegido />}>
            <Route index element={<DashboardPage />} />
            <Route path="monitores/nuevo" element={<MonitorFormPage modo="crear" />} />
            <Route path="monitores/:id" element={<MonitorDetailPage />} />
            <Route path="monitores/:id/editar" element={<MonitorFormPage modo="editar" />} />
            <Route path="canales" element={<CanalesPage />} />
            <Route path="incidencias" element={<IncidenciasPage />} />
            <Route path="entregas" element={<EntregasPage />} />
            <Route path="espacio" element={<EspacioPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
