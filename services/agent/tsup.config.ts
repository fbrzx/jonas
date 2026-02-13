import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
});
