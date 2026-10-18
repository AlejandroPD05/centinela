import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { loadEnv, loadEnvFileIfPresent } from '../config/env.js';
import { auditLog, memberships, users, workspaces } from '../db/schema.js';
import {
  canReachDatabase,
  createEphemeralDatabase,
  type EphemeralDatabase,
} from '../test/support.js';
import { signAccessToken } from './jwt.js';
import { hashPassword } from './password.js';

loadEnvFileIfPresent();

const databaseUrl = process.env.DATABASE_URL ?? '';
const dbAvailable = databaseUrl !== '' && (await canReachDatabase(databaseUrl));

if (!dbAvailable) {
  console.warn('PostgreSQL no disponible: la prueba de integración de accesos se salta.');
}

const JWT_SECRET = 'secreto-de-integracion-de-accesos-con-32-caracteres';
const PASSWORD = 'contraseña-de-pruebas-2026';

/**
 * Integración de M4: login, rotación de sesiones, claves de API, roles por
 * espacio, guardas de administración, auditoría y rutas públicas.
 */
describe.runIf(dbAvailable)('accesos — integración con PostgreSQL', () => {
  let ephemeral: EphemeralDatabase;
  let app: FastifyInstance;
  let workspaceId: string;
  let monitorId: string;

  let admin: { id: string; email: string; name: string; token: string };
  let editor: { id: string; email: string; name: string; token: string };
  let viewer: { id: string; email: string; name: string; token: string };
  let outsider: { id: string; email: string; name: string; token: string };
  let futureMemberId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase(databaseUrl, 'centinela_test_auth');
    const { db } = ephemeral;

    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      JWT_SECRET,
      LOGIN_ATTEMPTS_PER_MINUTE: '5',
    });

    const passwordHash = await hashPassword(PASSWORD);
    const makeUser = async (email: string, name: string) => {
      const [user] = await db.insert(users).values({ email, name, passwordHash }).returning();
      if (!user) throw new Error('no se pudo crear el usuario');
      return user;
    };

    const adminUser = await makeUser('admin@example.com', 'Admira');
    const editorUser = await makeUser('editor@example.com', 'Edita');
    const viewerUser = await makeUser('visor@example.com', 'Vera');
    const outsiderUser = await makeUser('ajeno@example.com', 'Ajeno');
    const futureUser = await makeUser('nueva@example.com', 'Nueva');
    futureMemberId = futureUser.id;

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Accesos', slug: `accesos-${randomUUID()}` })
      .returning();
    if (!workspace) throw new Error('no se pudo crear el espacio de trabajo');
    workspaceId = workspace.id;

    await db.insert(memberships).values([
      { userId: adminUser.id, workspaceId, role: 'admin' },
      { userId: editorUser.id, workspaceId, role: 'editor' },
      { userId: viewerUser.id, workspaceId, role: 'viewer' },
    ]);

    const tokenFor = (user: { id: string; email: string; name: string }) =>
      signAccessToken({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, 3_600);

    admin = {
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      token: tokenFor(adminUser),
    };
    editor = {
      id: editorUser.id,
      email: editorUser.email,
      name: editorUser.name,
      token: tokenFor(editorUser),
    };
    viewer = {
      id: viewerUser.id,
      email: viewerUser.email,
      name: viewerUser.name,
      token: tokenFor(viewerUser),
    };
    outsider = {
      id: outsiderUser.id,
      email: outsiderUser.email,
      name: outsiderUser.name,
      token: tokenFor(outsiderUser),
    };

    app = buildServer({ env, database: db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await ephemeral?.drop();
  });

  it('el login devuelve tokens y `me` lista los espacios con rol', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: PASSWORD },
    });

    expect(login.statusCode).toBe(200);

    const body = login.json<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { email: string };
    }>();
    expect(body.user.email).toBe(admin.email);
    expect(body.expiresIn).toBe(3_600);
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.refreshToken.length).toBeGreaterThan(30);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(body.accessToken),
    });
    expect(me.statusCode).toBe(200);

    const profile = me.json<{
      user: { id: string };
      workspaces: Array<{ id: string; role: string }>;
    }>();
    expect(profile.user.id).toBe(admin.id);
    expect(profile.workspaces).toContainEqual(
      expect.objectContaining({ id: workspaceId, role: 'admin' }),
    );
  });

  it('rechaza credenciales incorrectas y lo deja auditado', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: editor.email, password: 'no-es-la-buena' },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'fantasma@example.com', password: 'da-igual-1234' },
    });
    expect(unknownEmail.statusCode).toBe(401);

    const failures = await ephemeral.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.login_failed'));
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.some((row) => row.detail?.email === 'fantasma@example.com')).toBe(true);
  });

  it('frena la fuerza bruta por IP y correo', async () => {
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'victima@example.com', password: 'prueba-tras-prueba' },
      });
    }

    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rota el token de refresco y lo revoca con logout', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: viewer.email, password: PASSWORD },
    });
    const first = login.json<{ refreshToken: string }>().refreshToken;

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(rotated.statusCode).toBe(200);

    const second = rotated.json<{ refreshToken: string }>().refreshToken;
    expect(second).not.toBe(first);

    // El token ya rotado no vale dos veces.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(replay.statusCode).toBe(401);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refreshToken: second },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: second },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('la clave de API abre la puerta y se revoca', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: auth(admin.token),
      payload: { name: 'pruebas de integración' },
    });
    expect(created.statusCode).toBe(201);

    const { key, apiKey } = created.json<{ key: string; apiKey: { id: string; prefix: string } }>();
    expect(key.startsWith('cnt_')).toBe(true);
    expect(apiKey.prefix).toBe(key.slice(0, 12));

    const withKey = await app.inject({ method: 'GET', url: '/api/monitors', headers: auth(key) });
    expect(withKey.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/api-keys',
      headers: auth(admin.token),
    });
    expect(list.statusCode).toBe(200);

    const keys = list.json<{ apiKeys: Array<Record<string, unknown>> }>().apiKeys;
    expect(keys).toHaveLength(1);
    expect('keyHash' in (keys[0] ?? {})).toBe(false);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/api-keys/${apiKey.id}`,
      headers: auth(admin.token),
    });
    expect(revoked.statusCode).toBe(204);

    const dead = await app.inject({ method: 'GET', url: '/api/monitors', headers: auth(key) });
    expect(dead.statusCode).toBe(401);

    const actions = await ephemeral.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'apikey.create'));
    expect(actions).toHaveLength(1);
  });

  it('los roles mandan en el espacio', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth(viewer.token),
      payload: { type: 'http', workspaceId, name: 'No permitido', url: 'https://example.com/' },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth(editor.token),
      payload: { type: 'http', workspaceId, name: 'Portal', url: 'https://example.com/' },
    });
    expect(created.statusCode).toBe(201);

    const monitor = created.json<{ monitor: { id: string; slug: string } }>().monitor;
    expect(monitor.slug).toBe('portal');
    monitorId = monitor.id;

    const listed = await app.inject({
      method: 'GET',
      url: '/api/monitors',
      headers: auth(viewer.token),
    });
    expect(listed.json<{ monitors: unknown[] }>().monitors).toHaveLength(1);

    const viewerPatch = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      headers: auth(viewer.token),
      payload: { name: 'otro nombre' },
    });
    expect(viewerPatch.statusCode).toBe(403);

    // Quien no pertenece al espacio no ve nada ni puede tocar nada.
    const outsiderList = await app.inject({
      method: 'GET',
      url: '/api/monitors',
      headers: auth(outsider.token),
    });
    expect(outsiderList.json<{ monitors: unknown[] }>().monitors).toHaveLength(0);

    const outsiderDetail = await app.inject({
      method: 'GET',
      url: `/api/monitors/${monitor.id}`,
      headers: auth(outsider.token),
    });
    expect(outsiderDetail.statusCode).toBe(403);

    const noToken = await app.inject({ method: 'GET', url: '/api/monitors' });
    expect(noToken.statusCode).toBe(401);
  });

  it('CRUD de monitores: slug único, latidos y check a demanda', async () => {
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth(editor.token),
      payload: { type: 'http', workspaceId, name: 'Portal', url: 'https://example.com/' },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json<{ monitor: { slug: string } }>().monitor.slug).toBe('portal-2');

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth(editor.token),
      payload: {
        type: 'heartbeat',
        workspaceId,
        name: 'Cron nocturno',
        heartbeatPeriodSeconds: 3_600,
        heartbeatGraceSeconds: 300,
      },
    });
    expect(heartbeat.statusCode).toBe(201);

    const heartbeatMonitor = heartbeat.json<{
      monitor: { id: string; heartbeat: { token: string } | null };
    }>().monitor;
    expect(heartbeatMonitor.heartbeat?.token.startsWith('hb_')).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/monitors/${heartbeatMonitor.id}`,
      headers: auth(editor.token),
    });
    expect(detail.json<{ heartbeat: { token: string } }>().heartbeat.token).toBe(
      heartbeatMonitor.heartbeat?.token,
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth(editor.token),
      payload: { type: 'http', workspaceId, name: 'Mala URL', url: 'ftp://example.com/' },
    });
    expect(invalid.statusCode).toBe(400);

    const check = await app.inject({
      method: 'POST',
      url: `/api/monitors/${monitorId}/check`,
      headers: auth(editor.token),
    });
    expect(check.statusCode).toBe(202);

    const heartbeatCheck = await app.inject({
      method: 'POST',
      url: `/api/monitors/${heartbeatMonitor.id}/check`,
      headers: auth(editor.token),
    });
    expect(heartbeatCheck.statusCode).toBe(409);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitorId}`,
      headers: auth(editor.token),
      payload: { paused: true, expectedStatus: 204 },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      patched.json<{ monitor: { paused: boolean; expectedStatus: number } }>().monitor,
    ).toMatchObject({ paused: true, expectedStatus: 204 });

    const notApplicable = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${heartbeatMonitor.id}`,
      headers: auth(editor.token),
      payload: { url: 'https://example.com/' },
    });
    expect(notApplicable.statusCode).toBe(400);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/monitors/${heartbeatMonitor.id}`,
      headers: auth(editor.token),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/monitors/${heartbeatMonitor.id}`,
      headers: auth(editor.token),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('crea espacios y lista sus miembros', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: auth(admin.token),
      payload: { name: 'Otro espacio' },
    });
    expect(created.statusCode).toBe(201);

    const workspace = created.json<{ workspace: { id: string; slug: string; role: string } }>()
      .workspace;
    expect(workspace.slug).toBe('otro-espacio');
    expect(workspace.role).toBe('admin');

    const mine = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: auth(admin.token),
    });
    const spaces = mine.json<{ workspaces: Array<{ slug: string }> }>().workspaces;
    expect(spaces.map((space) => space.slug)).toContain('otro-espacio');

    const members = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(admin.token),
    });
    expect(members.statusCode).toBe(200);

    const rows = members.json<{ members: Array<{ email: string; role: string }> }>().members;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.role).sort()).toEqual(['admin', 'editor', 'viewer']);

    const viewerList = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(viewer.token),
    });
    expect(viewerList.statusCode).toBe(200);

    const viewerAdds = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(viewer.token),
      payload: { email: 'nueva@example.com', role: 'viewer' },
    });
    expect(viewerAdds.statusCode).toBe(403);
  });

  it('gestiona miembros con guarda del último administrador', async () => {
    const added = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(admin.token),
      payload: { email: 'nueva@example.com', role: 'editor' },
    });
    expect(added.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(admin.token),
      payload: { email: 'nueva@example.com', role: 'editor' },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(admin.token),
      payload: { email: 'nadie@example.com', role: 'viewer' },
    });
    expect(unknown.statusCode).toBe(404);

    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${futureMemberId}`,
      headers: auth(admin.token),
      payload: { role: 'viewer' },
    });
    expect(changed.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${futureMemberId}`,
      headers: auth(admin.token),
    });
    expect(removed.statusCode).toBe(204);

    // La única administración no puede degradarse ni salir del espacio.
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${admin.id}`,
      headers: auth(admin.token),
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);

    const leave = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${admin.id}`,
      headers: auth(admin.token),
    });
    expect(leave.statusCode).toBe(409);

    const actions = await ephemeral.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'member.add'));
    expect(actions).toHaveLength(1);
  });

  it('las rutas públicas siguen abiertas y el resto pide token', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const spec = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(spec.statusCode).toBe(200);
    const doc = spec.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/monitors');

    const docs = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');

    // Los latidos usan su propio token en la URL: sin él, 404 (no 401).
    const heartbeat = await app.inject({ method: 'POST', url: '/api/heartbeats/desconocido' });
    expect(heartbeat.statusCode).toBe(404);

    const protectedRoute = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(protectedRoute.statusCode).toBe(401);

    const brokenToken = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: auth('token-falso'),
    });
    expect(brokenToken.statusCode).toBe(401);
  });

  it('la auditoría muestra lo tuyo y lo de tus espacios', async () => {
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: auth(admin.token),
    });
    expect(entries.statusCode).toBe(200);

    const actions = entries
      .json<{ entries: Array<{ action: string }> }>()
      .entries.map((row) => row.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('monitor.create');
    expect(actions).toContain('apikey.revoke');
    expect(actions).toContain('member.remove');

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/audit?workspaceId=${workspaceId}`,
      headers: auth(admin.token),
    });
    expect(filtered.statusCode).toBe(200);

    const viewerAudit = await app.inject({
      method: 'GET',
      url: `/api/audit?workspaceId=${workspaceId}`,
      headers: auth(viewer.token),
    });
    expect(viewerAudit.statusCode).toBe(403);
  });
});
