import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Relative base so the site works on GitHub Pages under /AI-Energy-Dashboard/
// Date of the build (every push to main deploys a new build), in Eastern time
const lastUpdated = new Date().toLocaleDateString('en-US', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

export default defineConfig({
  base: './',
  define: { __LAST_UPDATED__: JSON.stringify(lastUpdated) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
