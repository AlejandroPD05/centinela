/** Código y restricción de un error de PostgreSQL, aunque Drizzle lo envuelva. */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
}

/** Recorre la cadena de `cause` buscando el error original de `pg`. */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  if (typeof error !== 'object' || error === null) return {};

  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return {
      code: candidate.code,
      ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
    };
  }

  return pgErrorInfo(candidate.cause);
}
