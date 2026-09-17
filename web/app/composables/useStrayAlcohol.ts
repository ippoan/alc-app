import type { StrayAlcoholReading } from '~/types'
import { readAlcohol, toAlcoholReading } from '~/utils/alcohol'

/**
 * 本人確認の前 (待機画面 / 種別の選択画面) に届いたアルコール測定を購読する
 * (Refs ippoan/rust-alc-api#644)。
 *
 * `useBleGateway.wire()` は `medical` 段まで JSON ハンドラを登録しないため、
 * それより前に届いた alcohol JSON は `useCoreS3Serial.dispatchJson` で購読者
 * 0 件のまま捨てられる。測定自体は CoreS3 ハブ側が既に保存しているので
 * (`hub_measurements` に `session_id: null` で入る)、タブレットは「測りましたよ」
 * と知らせるだけでよい。**保存も紐付けもしない**。
 *
 * `useBleGateway.wire()` には一切触らない — 前倒しすると heartbeat 監視まで
 * 前倒しになり、30 秒無音で `coreS3.release()` が走って NFC と共用の USB
 * ポートを手放す経路を新設してしまう。
 */
const latest = ref<StrayAlcoholReading | null>(null)
let seq = 0
// onJson は解除の口を返さない (useCoreS3Serial.ts) ので、購読は 1 回だけにする
// (useCoreS3Stage と同型のガード)
let wired = false

export function useStrayAlcohol() {
  const coreS3 = useCoreS3Serial()

  if (!wired) {
    wired = true
    coreS3.onJson((msg) => {
      if ((msg as { type?: unknown } | null)?.type !== 'alcohol') return
      const reading = toAlcoholReading(readAlcohol(msg))
      if (!reading) return
      latest.value = {
        ...reading,
        seq: ++seq,
      }
    })
  }

  return {
    latest: readonly(latest),
  }
}
