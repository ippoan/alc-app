import { defineVitestConfig } from '@nuxt/test-utils/config'
import { resolve } from 'path'

export default defineVitestConfig({
  test: {
    globals: true,
    // console を worker → main の rpc (onUserConsoleLog) 経由にしない。テストが全部通っても、
    // 完了を待たれない非同期の console 出力が worker の後片付けと競ると
    // `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` で exit 1 になる。
    // 全体を並列に回したときだけ起き、単体では再現しにくい (Refs #385)。
    // unhandled error を無視する設定ではない: 出力は worker の標準出力へそのまま出る。
    disableConsoleIntercept: true,
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
        // 同梱した wasm の glue (生成物。出どころは app/vendor/vein-match/README.md)
        'app/vendor/**',
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
