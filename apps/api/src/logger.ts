import type { FastifyServerOptions } from 'fastify';
import type { Env } from './config/env.js';

/**
 * Opciones de log para Fastify (pino). En desarrollo y con terminal interactiva
 * se imprime legible; en producción, JSON estructurado listo para recolectar.
 */
export function loggerOptions(env: Env): FastifyServerOptions['logger'] {
  const usePretty = env.NODE_ENV === 'development' && process.stdout.isTTY === true;

  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}
