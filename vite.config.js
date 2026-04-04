// vite.config.js
//import legacy from '@vitejs/plugin-legacy'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default {
  // base: '/deploy.kodidash',
  build: {
    manifest: true,
    // minify: 'terser', // Slower, but trying for older iOS support
    // target: 'es2020', // ensure modern bundle keeps destructuring, etc.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        logo: resolve(__dirname, 'logo.html'),
      },
    },
  },
  plugins: [
    tailwindcss(),
    // legacy({
    //   // Legacy bundle baseline
    //   targets: ['defaults', 'not IE 11', 'not Safari < 13', 'not iOS < 13'],
    //   // IMPORTANT: raise the modern bundle baseline too (drops Safari 12)
    //   modernTargets: ['edge>=79', 'firefox>=67', 'chrome>=64', 'safari>=13', 'ios>=13'],
    // }),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: false },  // Disable PWA in dev - breaks HMR, requiring shift-reload to see new code changes...
      manifest: {
        // caches the assets/icons mentioned (assets/* includes all the assets present in your src/ directory)
        includeAssets: ['images/kodi.svg', 'images/jellyfin-logo.png', 'images/weather-icons/svg/*', 'assets/*'],
        name: '10 Foot Dash',
        short_name: '10ft Dash',
        start_url: '/?fullscreen=true',
        background_color: '#000000',
        theme_color: '#000000',
        display: 'fullscreen',
        icons: [{ src: '/images/kodi.svg', sizes: 'any', type: 'image/svg' }],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'] },
    }),
  ],
}