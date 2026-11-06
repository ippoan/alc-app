/**
 * 指静脈の個体値の計測の手順 (Refs ippoan/alc-app-s3#352)。
 *
 * 選んだ乗務員に、同じ端末で `count` 回置いてもらう。1 回ごとに `VEIN IDENTIFY KEEP ALL` (置いた 1 回を撮ってから
 * 照合) を打ち、撮った記録を認証ログとしてサーバーへ送って本人との判定 (点数・規則・位置のずれ) を受け取り、
 * 同じ回の `VEIN CAPLOG` (撮れ方の明るさ) と並べる。計算は `utils/vein-device-profile.ts`。
 *
 * - 照合の結果で画面を進めない・記録を入れ替えない (計測だけ。登録の記録には触らない)
 * - 送る先は普段の認証ログと同じ口 (`POST /api/vein/auth-shots`)。サーバーが端末を鍵から決めるので、
 *   同じ端末の回はサーバーの記録でも端末ごとに引ける
 * - 生体データは画面に出さない
 */

import { computed, ref } from 'vue'
import { postVeinAuthShotJudged, type RequestTokenScope } from '~/utils/api'
import { loadVeinModuleEntries } from '~/utils/vein-db'
import { onVeinLine } from '~/utils/vein-line-log'
import { parseVeinCapLog, summarizeVeinProfile, type VeinCapLog, type VeinProfileShot } from '~/utils/vein-device-profile'
import type { KeepResult } from '~/utils/vein-module'

/** 1 回ごとの間 (指を離して置き直してもらう) */
export const VEIN_PROFILE_RELEASE_MS = 2_500
export const VEIN_PROFILE_DEFAULT_COUNT = 10

export interface VeinProfilePort {
  identifyKeep: (onAgain?: () => void) => Promise<KeepResult>
}

export type VeinProfileGuide = 'place' | 'again' | 'release' | null

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useVeinDeviceProfile(opts: {
  port: VeinProfilePort
  scope?: RequestTokenScope
  sleep?: (ms: number) => Promise<void>
}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const shots = ref<VeinProfileShot[]>([])
  const busy = ref(false)
  const guide = ref<VeinProfileGuide>(null)
  const error = ref<string | null>(null)
  let stopped = false

  const profile = computed(() => summarizeVeinProfile(shots.value))

  async function one(n: number, employeeId: string): Promise<VeinProfileShot> {
    let cap: VeinCapLog | null = null
    const off = onVeinLine((line) => {
      const got = parseVeinCapLog(line)
      if (got) cap = got
    })
    const shot: VeinProfileShot = { n, module: 'none', server: null, scores: null, rule: null, dx: null, dy: null, overlap: null, cap: null, error: null }
    try {
      guide.value = 'place'
      const got = await opts.port.identifyKeep(() => { guide.value = 'again' })
      if (got.id !== null) {
        const entry = (await loadVeinModuleEntries()).find(e => e.moduleId === got.id)
        // 計測なので承認は見ない (承認待ちの本人の枠に当たっても本人)
        shot.module = entry?.employeeId === employeeId ? 'self' : 'other'
      }
      if (!got.record) {
        shot.error = '撮った記録が届きませんでした (古いファーム)'
        return shot
      }
      const j = await postVeinAuthShotJudged({
        employee_id: employeeId,
        shot: got.record,
        module: {
          result: got.id === null ? 'NOMATCH' : 'IDENTIFIED',
          slot: got.id,
          hit: shot.module,
          score: got.score ?? null,
          thresholds: got.thresholds ?? null,
        },
        firmware: got.firmware ?? null,
        captured_at: new Date().toISOString(),
      }, opts.scope)
      if (!j) {
        shot.error = 'サーバーが判定を返しませんでした (認証ログの対象外のテナント)'
        return shot
      }
      shot.server = j.result
      shot.scores = j.scores
      shot.rule = j.rule
      shot.dx = j.shift?.dx ?? null
      shot.dy = j.shift?.dy ?? null
      shot.overlap = j.shift?.overlap ?? null
      return shot
    }
    catch (e) {
      shot.error = messageOf(e)
      return shot
    }
    finally {
      off()
      shot.cap = cap
    }
  }

  async function run(employeeId: string, count: number = VEIN_PROFILE_DEFAULT_COUNT): Promise<void> {
    if (busy.value) return
    busy.value = true
    stopped = false
    error.value = null
    shots.value = []
    try {
      for (let n = 1; n <= count && !stopped; n++) {
        shots.value = [...shots.value, await one(n, employeeId)]
        if (n < count && !stopped) {
          guide.value = 'release'
          await sleep(VEIN_PROFILE_RELEASE_MS)
        }
      }
    }
    catch (e) {
      error.value = messageOf(e)
    }
    finally {
      guide.value = null
      busy.value = false
    }
  }

  /** 今の回が終わったところで止める */
  function stop(): void {
    stopped = true
  }

  return { shots, busy, guide, error, profile, run, stop }
}
