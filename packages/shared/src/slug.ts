/**
 * Convierte un texto libre en un slug legible: minúsculas, sin acentos y con
 * guiones como separador. Devuelve cadena vacía cuando no queda nada
 * aprovechable (cada llamada decide su respaldo). Se usa para los slugs de
 * monitores, espacios de trabajo y badges.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.slice(0, 60).replace(/-+$/g, '');
}
