import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'node:fs'
import path from 'node:path'

const localCert = process.env.LOCAL_HTTPS_CERT
const localKey = process.env.LOCAL_HTTPS_KEY
const localHttps = localCert && localKey
  ? {
      cert: fs.readFileSync(path.resolve(localCert)),
      key: fs.readFileSync(path.resolve(localKey)),
    }
  : undefined

export default defineConfig({
  server: { host: '0.0.0.0', ...(localHttps ? { https: localHttps } : {}) },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the shared hosted database client out of the app entry chunk.
          if (id.includes('/node_modules/@supabase/')) return 'supabase'
        },
      },
    },
  },
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
    manifest: {
      name: 'MoneyMate', short_name: 'MoneyMate', description: 'Quản lý tài chính cá nhân',
      theme_color: '#eae7d6', background_color: '#eae7d6', display: 'standalone',
      start_url: '/', lang: 'vi',
      icons: [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ]
    },
    workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] }
  })]
})
