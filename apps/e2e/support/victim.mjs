// Servidor víctima: el servicio vigilado durante las pruebas. Responde 200
// cuando está «sano» y 500 cuando se le pide caer, de forma que el worker real
// lo detecte igual que una caída de verdad.
import { createServer } from 'node:http';
import { VICTIM_PORT } from './ports.mjs';

const port = Number(process.env.VICTIM_PORT ?? VICTIM_PORT);
let mode = 'up';

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

  if (path === '/control/down' || path === '/control/up') {
    mode = path.endsWith('down') ? 'down' : 'up';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, mode }));
    return;
  }

  if (path === '/control/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mode }));
    return;
  }

  if (mode === 'down') {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('la caja fuerte está en llamas');
    return;
  }

  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('caja fuerte ok');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[e2e] víctima escuchando en http://127.0.0.1:${port} (modo ${mode})`);
});
