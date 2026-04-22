const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    platform: 'node',
    format: 'cjs',
    minify: false,
    sourcemap: false,
  })
  .catch(() => process.exit(1));
