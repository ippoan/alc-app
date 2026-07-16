import { defineVitestConfig } from '@nuxt/test-utils/config'
import { resolve } from 'path'

export default defineVitestConfig({
  test: {
    globals: true,
    environment: 'nuxt',
    environmentOptions: {
      nuxt: {
        domEnvironment: 'happy-dom',
      },
    },
    setupFiles: ['./tests/save-native.ts', './tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      include: ['app/**/*.ts'],
      exclude: [
        'app/types/**',
        'app/workers/**',
        'app/web-serial.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      'fc1200-wasm': resolve(import.meta.dirname!, 'tests/mocks/fc1200-wasm.ts'),
      // Windows で virtual module の file URL 解決が落ちるためスタブに差し替え
      'virtual:pwa-register/vue': resolve(import.meta.dirname!, 'tests/mocks/pwa-register.ts'),
    },
  },
})
