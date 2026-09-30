/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [svelte(), {
    name: 'dbx-ui-build-success',
    writeBundle() { console.log('DBX_UI_BUILD_SUCCESS') }
  }],
  build: {
    outDir: '../../ui',
    emptyOutDir: true,
    target: 'es2020'
  },
  test: {
    include: ['../**/*.test.ts'],
    passWithNoTests: true
  }
})
