import { describe, expect, it } from 'vitest';
import { slugify } from './slug.js';
import { hasRole } from './types.js';

describe('slugify', () => {
  it('pasa a minúsculas, quita acentos y une con guiones', () => {
    expect(slugify('API de ejemplo')).toBe('api-de-ejemplo');
    expect(slugify('Café del Norte!')).toBe('cafe-del-norte');
    expect(slugify('  --Hola   Mundo--  ')).toBe('hola-mundo');
    expect(slugify('Ñoño & Cía.')).toBe('nono-cia');
  });

  it('deja vacías las cadenas sin nada aprovechable', () => {
    expect(slugify('')).toBe('');
    expect(slugify('¡—!')).toBe('');
    expect(slugify('日本語')).toBe('');
  });

  it('recorta a 60 caracteres sin dejar un guion colgando', () => {
    const slug = slugify(`${'x'.repeat(59)} y`);
    expect(slug).toBe('x'.repeat(59));
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});

describe('hasRole', () => {
  it('ordena los privilegios viewer < editor < admin', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('admin', 'editor')).toBe(true);
    expect(hasRole('admin', 'viewer')).toBe(true);
    expect(hasRole('editor', 'admin')).toBe(false);
    expect(hasRole('editor', 'editor')).toBe(true);
    expect(hasRole('editor', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'admin')).toBe(false);
    expect(hasRole('viewer', 'editor')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });
});
