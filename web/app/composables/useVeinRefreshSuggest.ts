/**
 * 「この端末で撮り直す」の提案。指静脈の照合が `VIA=FP` (指紋互換の層でだけ当たった = 壊れやすく、
 * 次は外れやすい) で通ったとき、**流れを止めずに**撮り直しを勧める。承認すると
 * {@link useVeinAddDevice} の `add` で、この端末の置き方で撮り直した記録をその人の分として預ける。
 * 判定は `via` だけ (`SCORE` / `TH` はまだ当てにならない)。`FV`・`null` (古いファーム) は出さない。
 *
 * 診断ログ: `[vein] 撮り直しの提案 shown|accepted|dismissed screen=<label>` (氏名・社員 id は出さない)
 */
import type { RequestTokenScope } from '~/utils/api'
import { appendDiag } from '~/utils/serialDiagLog'

export function useVeinRefreshSuggest(opts: { scope: RequestTokenScope, label: string }) {
  const fingerAdd = useVeinAddDevice({ scope: opts.scope })
  /** 提案の対象 (撮り直す人の社員 id)。出していなければ null */
  const target = ref<string | null>(null)

  function log(event: 'shown' | 'accepted' | 'dismissed'): void {
    const msg = `[vein] 撮り直しの提案 ${event} screen=${opts.label}`
    console.info(msg)
    appendDiag(msg)
  }

  /** 照合が通った人 `employeeId` について、`via` が FP なら提案を出す */
  function offer(employeeId: string, via: 'FV' | 'FP' | null): void {
    if (via !== 'FP') return
    fingerAdd.reset()
    target.value = employeeId
    log('shown')
  }

  /** 「この端末で撮り直す」 */
  async function accept(): Promise<void> {
    if (target.value === null) return
    log('accepted')
    await fingerAdd.add(target.value)
  }

  /** 「あとで」 */
  function dismiss(): void {
    if (target.value === null) return
    log('dismissed')
    clear()
  }

  /** 次の人・画面のやり直しで、ログを残さず片付ける */
  function clear(): void {
    target.value = null
    fingerAdd.reset()
  }

  return {
    target: readonly(target),
    adding: fingerAdd.adding,
    added: fingerAdd.added,
    error: fingerAdd.error,
    notice: fingerAdd.notice,
    available: fingerAdd.available,
    offer,
    accept,
    dismiss,
    clear,
  }
}
