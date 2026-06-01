import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import process from 'node:process'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || `http://127.0.0.1:${process.env.API_PORT || 8790}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    allowedHosts: ['dnd.throne.middl.earth', 'dnd.middl.earth'],
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: ['dnd.throne.middl.earth', 'dnd.middl.earth'],
  },
})
