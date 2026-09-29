import { afterEach, beforeEach, vi } from 'vitest'

// TenkoKiosk 系のテストが mount 後に遅れて出す console 出力を、vitest の rpc
// (`onUserConsoleLog`) に流さず、テストファイルの中で受ける (Refs ippoan/alc-app#385)。
//
// 完了を待たれない console 出力が worker の後片付けと競ると、テストが全部通っても
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` で
// exit 1 になる。全体を並列に回したときだけ起きるので、単体では再現しにくい。

/**
 * `~/utils/vein-identify` の部分 mock の factory。mount ごとに走る `void syncVeinTemplates()`
 * (TenkoKiosk.vue の onMounted) を解決済みにする。照合データの同期はこれらのテストの関心事ではなく、
 * 本物のままだと api mock に getVeinTemplates が無くて `[vein] 照合データの同期に失敗` が出る。
 *
 * 使い方 (vi.mock は巻き上げられるので factory の中で import する):
 *   vi.mock('~/utils/vein-identify', async (orig) => (await import('../helpers/console-guard')).veinSyncMock(orig))
 */
export async function veinSyncMock(importOriginal: () => Promise<typeof import('~/utils/vein-identify')>) {
  return { ...(await importOriginal()), syncVeinTemplates: vi.fn(async () => false) }
}

/** CoreS3 の無い環境では端末の署名が取れない。点呼の流れには関係しない */
export const KNOWN_DEVICE_TOKEN_WARN = /^\[useDeviceToken\] 端末の署名に失敗 stage=no-core-s3 /
/** 録画の掃除 (VideoStore) の定例ログ */
export const KNOWN_VIDEO_STORE_LOG = /^\[VideoStore\] Cleanup: deleted \d+ videos older than 7 days$/

/**
 * console.warn/error/info/log/debug をこのファイルの中で受け、各ケースの後に
 * **`known` のどれにも当たらない出力があれば失敗にする** (黙らせるだけにしない)。
 * `known` のものが出なくなっても落ちない (後で直したときにテストが壊れないように)。
 *
 * spy は**ファイルの最後まで戻さない**。各ケースの後に戻すと、最後のケースの後に遅れて出た分が
 * 実 console に流れて同じ競合になる。vitest はファイルごとに module を分けるので他へは漏れない。
 * テストファイルの最上位で 1 度だけ呼ぶ。
 */
export function guardConsole(known: RegExp[] = []) {
  const spies = (['warn', 'error', 'info', 'log', 'debug'] as const)
    .map(m => vi.spyOn(console, m).mockImplementation(() => {}))

  beforeEach(() => {
    spies.forEach(s => s.mockClear())
  })
  afterEach(() => {
    const unexpected = spies
      .flatMap(s => s.mock.calls)
      .map(args => String(args[0]))
      .filter(msg => !known.some(re => re.test(msg)))
    if (unexpected.length) throw new Error(`想定外の console 出力:\n${unexpected.join('\n')}`)
  })

  return {
    /**
     * 仕様どおり出るはずの出力 (失敗しても続ける経路の warn など) を、そのケースの中で受けて
     * 取り除く。`re` に当たった呼び出しの引数を返すので、出たこと自体を expect できる。
     * 取り除いた分は afterEach の「想定外」に数えない。
     */
    takeOutput(re: RegExp): unknown[][] {
      const taken: unknown[][] = []
      for (const s of spies) {
        for (let i = s.mock.calls.length - 1; i >= 0; i--) {
          if (re.test(String(s.mock.calls[i]![0]))) taken.unshift(...s.mock.calls.splice(i, 1))
        }
      }
      return taken
    },
  }
}
