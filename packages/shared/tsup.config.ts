import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'types/index': 'src/types/index.ts',
    'utils/index': 'src/utils/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
