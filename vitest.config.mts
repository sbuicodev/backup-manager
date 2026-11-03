import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { TZ: 'Europe/Rome' }
  }
})
