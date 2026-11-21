import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

function antigravityClassicHtml(): Plugin {
  return {
    name: 'antigravity-classic-html',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/\s+crossorigin(?:="[^"]*")?/g, '')
        .replace(
          /<script\s+type="module"\s+src="(\/app\.js)"><\/script>/g,
          '<script src="$1" defer></script>'
        );
    },
  };
}

export default defineConfig({
  plugins: [svelte(), antigravityClassicHtml()],
  build: {
    outDir: resolve(__dirname, '../dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        format: 'iife',
        name: 'LockBoardApp',
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        codeSplitting: false,
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'styles.css' : 'assets/[name][extname]',
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3791', changeOrigin: true },
      '/preload.js': { target: 'http://127.0.0.1:3791', changeOrigin: true },
    },
  },
});
