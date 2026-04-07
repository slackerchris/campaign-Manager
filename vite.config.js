import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    allowedHosts: ['dnd.throne.middl.earth', 'dnd.middl.earth'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: ['dnd.throne.middl.earth', 'dnd.middl.earth'],
  },
})
