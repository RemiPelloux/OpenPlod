import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const build = { version, builtAt: new Date().toISOString() }

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'openplod-build-identity',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'openplod-build', content: `${build.version} ${build.builtAt}` }, injectTo: 'head' }],
  }],
  define: { __OPENPLOD_BUILD__: JSON.stringify(build) },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3487',
        changeOrigin: true,
      },
      '/audio': {
        target: 'http://localhost:3487',
        changeOrigin: true,
      },
    },
  },
})
