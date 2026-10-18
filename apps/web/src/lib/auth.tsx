import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  setSessionEndedHandler,
  tokens,
  watchTokenStorage,
} from './api';
import type { SessionUser, Workspace } from './types';

const WORKSPACE_KEY = 'centinela.workspace_id';

interface AuthState {
  /** Ya se intentó restaurar la sesión (o no había nada que restaurar). */
  ready: boolean;
  user: SessionUser | null;
  workspaces: Workspace[];
  /** Espacio activo; null si el usuario no pertenece a ninguno. */
  workspaceId: string | null;
  workspace: Workspace | null;
  setWorkspaceId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Sesión del panel. El token de acceso vive en memoria; al arrancar se
 * canjea el refresco guardado y, si otra pestaña lo rota, se adopta el suyo.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [storedWorkspaceId, setStoredWorkspaceId] = useState<string | null>(() =>
    window.localStorage.getItem(WORKSPACE_KEY),
  );

  const adopt = useCallback((me: Awaited<ReturnType<typeof fetchMe>>) => {
    setUser({ id: me.user.sub, email: me.user.email, name: me.user.name });
    setWorkspaces(me.workspaces);
    setReady(true);
  }, []);

  const clear = useCallback(() => {
    setUser(null);
    setWorkspaces([]);
    setReady(true);
  }, []);

  const reloadMe = useCallback(async () => {
    adopt(await fetchMe());
  }, [adopt]);

  // Arranque: intenta canjear el refresco persistido.
  useEffect(() => {
    let cancelled = false;
    tokens.load();

    void (async () => {
      if (!tokens.hasRefresh()) {
        if (!cancelled) clear();
        return;
      }

      const renewed = await refreshSession();
      if (cancelled) return;

      if (!renewed) {
        tokens.clear();
        clear();
        return;
      }

      try {
        const me = await fetchMe();
        if (!cancelled) adopt(me);
      } catch {
        if (!cancelled) clear();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adopt, clear]);

  // La sesión murió (401 sin remedio): la UI vuelve a /login.
  useEffect(() => {
    setSessionEndedHandler(clear);
    return () => setSessionEndedHandler(null);
  }, [clear]);

  // Otra pestaña rotó el token: revalidamos con el nuevo.
  useEffect(
    () =>
      watchTokenStorage(() => {
        void reloadMe().catch(clear);
      }),
    [reloadMe, clear],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      await loginRequest(email, password);
      adopt(await fetchMe());
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    clear();
  }, [clear]);

  const setWorkspaceId = useCallback((id: string) => {
    setStoredWorkspaceId(id);
    window.localStorage.setItem(WORKSPACE_KEY, id);
  }, []);

  // El espacio guardado si sigue existiendo; si no, el primero disponible.
  const workspaceId = useMemo(() => {
    if (storedWorkspaceId !== null && workspaces.some((w) => w.id === storedWorkspaceId)) {
      return storedWorkspaceId;
    }
    return workspaces[0]?.id ?? null;
  }, [storedWorkspaceId, workspaces]);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      workspaces,
      workspaceId,
      workspace,
      setWorkspaceId,
      login,
      logout,
      reloadMe,
    }),
    [ready, user, workspaces, workspaceId, workspace, setWorkspaceId, login, logout, reloadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth se usa fuera de <AuthProvider>');
  return context;
}
