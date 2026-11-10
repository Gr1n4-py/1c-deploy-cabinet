import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Дев-режим: API проксируется на сервер Electron-приложения (порт 8181).
    // В проде тот же сервер встроен в Cabinet.exe и раздает dist/ сам.
    proxy: {
      '/api': 'http://127.0.0.1:8181',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
