import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm'],
    target: 'node20',
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    shims: false,
  },
  {
    entry: {
      cli: 'src/cli.ts',
    },
    format: ['esm'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    onSuccess: async () => {
      // Copy web files to dist
      const webFiles = [
        'src/web/public/index.html',
        'src/web/public/styles.css',
        'src/web/public/app.js',
      ];

      const destDir = 'dist/web/public';
      mkdirSync(destDir, { recursive: true });

      for (const file of webFiles) {
        const dest = join(destDir, file.split('/').pop()!);
        copyFileSync(file, dest);
        console.log(`Copied ${file} to ${dest}`);
      }
    },
  },
]);
