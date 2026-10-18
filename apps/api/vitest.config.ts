import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Los tests importan `@centinela/shared` directamente desde su código fuente:
 * así `pnpm test` funciona sin necesidad de compilar el paquete antes.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@centinela/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    testTimeout: 15_000,
  },
});
