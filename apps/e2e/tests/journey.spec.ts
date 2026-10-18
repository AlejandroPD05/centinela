import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import {
  E2E_DATABASE,
  E2E_EMAIL,
  E2E_MONITOR,
  E2E_PASSWORD,
  VICTIM_PORT,
} from '../support/ports.mjs';

// La configuración de Playwright arranca API, víctima y panel; aquí se abre un
// cliente directo a la base E2E para forzar checks y comprobar el estado real
// que ha dejado el worker.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // El error de conexión lo contará el propio cliente.
}

function e2eDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('falta DATABASE_URL (copia .env.example a .env)');
  const url = new URL(base);
  url.pathname = `/${E2E_DATABASE}`;
  return url.toString();
}

/**
 * Viaje completo por Centinela: la página pública, la insignia, el acceso del
 * operador y una caída con su incidencia y su recuperación, moviendo la víctima
 * de verdad y dejando que el worker las detecte.
 */
test.describe('viaje completo por Centinela', () => {
  test.describe.configure({ mode: 'serial' });

  let db: Client;

  test.beforeAll(async () => {
    db = new Client({ connectionString: e2eDatabaseUrl() });
    await db.connect();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  const fuerzaCheck = async (slug: string) => {
    await db.query('update monitors set next_check_at = now() where slug = $1', [slug]);
  };

  /**
   * La status page se cachea 30 s a propósito (la sirve un proxy/CDN), así que
   * las visitas de las pruebas llevan un parámetro único: llegan frescas, como
   * un visitante nuevo.
   */
  const abrirStatus = (page: Page) => page.goto(`/status/e2e?t=${Date.now()}`);

  const estado = async (slug: string): Promise<string> => {
    const { rows } = await db.query<{ state: string }>(
      'select state from monitors where slug = $1',
      [slug],
    );
    return rows[0]?.state ?? '(sin monitor)';
  };

  const incidenciasAbiertas = async (slug: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n
         from incidents i
         join monitors m on m.id = i.monitor_id
        where m.slug = $1 and i.resolved_at is null`,
      [slug],
    );
    return rows[0]?.n ?? -1;
  };

  test('la status page pública enseña el servicio vigilado', async ({ page }) => {
    await fuerzaCheck(E2E_MONITOR);
    await expect.poll(() => estado(E2E_MONITOR), { timeout: 20_000 }).toBe('up');

    await abrirStatus(page);
    await expect(page.getByText('Vitrina E2E')).toBeVisible();
    await expect(page.getByText('Caja fuerte')).toBeVisible();
    await expect(page.getByText('Todos los servicios responden.')).toBeVisible();
  });

  test('la insignia SVG responde para el README', async ({ request }) => {
    const response = await request.get(`/badge/e2e/${E2E_MONITOR}.svg`);

    expect(response.status()).toBe(200);
    const svg = await response.text();
    expect(svg).toContain('<svg');
  });

  test('el panel deja entrar al operador y enseña el monitor', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Correo').fill(E2E_EMAIL);
    await page.getByLabel('Contraseña').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Caja fuerte').first()).toBeVisible();

    await page.getByText('Caja fuerte').first().click();
    await expect(page).toHaveURL(/monitores\//);
    await expect(page.getByText('Caja fuerte').first()).toBeVisible();
  });

  test('la caída abre incidencia y la recuperación la cierra', async ({ page, request }) => {
    // 1) La víctima cae; el worker lo detecta en el check forzado.
    expect((await request.post(`http://127.0.0.1:${VICTIM_PORT}/control/down`)).ok()).toBe(true);

    await fuerzaCheck(E2E_MONITOR);
    await expect.poll(() => estado(E2E_MONITOR), { timeout: 20_000 }).toBe('down');
    await expect.poll(() => incidenciasAbiertas(E2E_MONITOR), { timeout: 10_000 }).toBe(1);

    // 2) La página pública lo declara.
    await abrirStatus(page);
    await expect(page.getByText('Un servicio no responde.')).toBeVisible();
    await expect(page.locator('.incidencia', { hasText: 'Caja fuerte' })).toBeVisible();

    // 3) Se recupera: el worker cierra la incidencia.
    expect((await request.post(`http://127.0.0.1:${VICTIM_PORT}/control/up`)).ok()).toBe(true);

    await fuerzaCheck(E2E_MONITOR);
    await expect.poll(() => estado(E2E_MONITOR), { timeout: 20_000 }).toBe('up');
    await expect.poll(() => incidenciasAbiertas(E2E_MONITOR), { timeout: 10_000 }).toBe(0);

    await abrirStatus(page);
    await expect(page.getByText('Todos los servicios responden.')).toBeVisible();
  });
});
