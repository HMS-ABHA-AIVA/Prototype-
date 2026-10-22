import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // BACKEND_URL is read from .env files / the shell (not exposed to the browser).
  const env = loadEnv(mode, process.cwd(), '')

  // Local dev/preview forwards `/api` to the backend. Render builds the static
  // frontend with VITE_API_URL pointing at the separately deployed API service.
  const proxy = {
    '/api': { target: env.BACKEND_URL || 'http://localhost:5000', changeOrigin: true },
  }

  return {
    plugins: [react()],
    // "@/foo" in an import means "src/foo"
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { host: '0.0.0.0', port: 5180, proxy },
    preview: { host: '0.0.0.0', port: 5180, proxy },
  }
})
