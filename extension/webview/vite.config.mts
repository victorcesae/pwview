import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: path.resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: { entryFileNames: 'index.js', assetFileNames: 'index.[ext]', inlineDynamicImports: true },
    },
  },
});
