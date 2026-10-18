/**
 * Configuración del servidor MCP, por variables de entorno:
 *
 * - `CENTINELA_URL` (por defecto `http://127.0.0.1:4100`)
 * - `CENTINELA_API_KEY` (obligatoria; se crea en el panel → Espacio → Claves)
 * - `CENTINELA_WORKSPACE` (opcional: espacio por defecto si la herramienta no
 *   recibe ninguno)
 */
export interface McpConfig {
  baseUrl: string;
  apiKey: string;
  workspace?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const baseUrl = (env.CENTINELA_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/+$/, '');

  const apiKey = env.CENTINELA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'falta CENTINELA_API_KEY: crea una clave en el panel (Espacio → Claves) y expórtala',
    );
  }

  const workspace = env.CENTINELA_WORKSPACE?.trim();

  return { baseUrl, apiKey, ...(workspace ? { workspace } : {}) };
}
