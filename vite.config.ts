import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './', // relative, so the build works at the GitHub Pages subpath and at the root
  test: { include: ['src/**/*.test.ts'] },
});
