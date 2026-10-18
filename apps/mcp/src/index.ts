#!/usr/bin/env node
// Servidor MCP de Centinela: expone el estado y las incidencias a un asistente
// por stdio. Configuración por entorno:
//
//   CENTINELA_URL       base de la API (por defecto http://127.0.0.1:4100)
//   CENTINELA_API_KEY   clave de API con rol de lectura (obligatoria)
//   CENTINELA_WORKSPACE espacio por defecto si la herramienta no recibe uno
//
// stdout es del protocolo: los avisos del proceso van a stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './api.js';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const api = createApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  const server = new McpServer({ name: 'centinela', version: '0.1.0' });
  registerTools(server, { api, config });

  await server.connect(new StdioServerTransport());

  console.error(
    `centinela-mcp listo (${config.baseUrl}${config.workspace ? `, espacio «${config.workspace}»` : ''})`,
  );
}

main().catch((error: unknown) => {
  console.error(`centinela-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
