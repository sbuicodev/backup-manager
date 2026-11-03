import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { TZ: 'Europe/Rome' },
    // Engine tests zip and copy real files; shared CI runners can be several times slower.
    testTimeout: 30_000
  }
})
