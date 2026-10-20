/**
 * 預かったポートへの要求を、「既に応答待ち」で弾かれたときだけ間を置いて送り直す共通の口
 * (useSerialOta の再起動後の問い合わせ・DeviceSettings の OMRON 設定・useVeinSerial の
 * `OMRON STATUS` の 3 か所が使う、Refs ippoan/alc-app#436)。
 *
 * ポートは同時に 1 件しか応答を待てず、端末の鍵の署名 (`AUTH SIGN`、最大 10 秒) と重なると
 * 即 reject される。その理由のときだけ待って呼び直す。機体が断った・時間切れは送り直さない。
 */

/**
 * ポートがほかの要求の応答待ちで、こちらの要求を送らずに弾いたか。判定は useSerialArbiter.ts の
 * reject 文言 (`request(<name>): 既に応答待ちです`) の部分一致。文言を変えたらここも合わせること
 */
export function isPortBusy(e: unknown): boolean {
  return String(e).includes('既に応答待ちです')
}

export interface RequestWhenFreeOptions {
  /** 弾かれてから呼び直すまでの間隔 */
  intervalMs: number
  /** この時刻 (epoch ms) を超えるなら呼び直さずに諦める */
  deadline?: number
  /** 呼び直す回数の上限 */
  maxRetries?: number
  /** true を返したら呼び直さずに諦める (unmount など)。待ったあとに見る */
  isCancelled?: () => boolean
  /** 諦めるときに投げるエラーを作る。省略時は最後に弾かれたエラーのまま */
  giveUp?: (e: Error) => Error
}

/**
 * `send` を呼び、{@link isPortBusy} で弾かれたときだけ間を置いて呼び直す。
 * 弾く以外の失敗は呼び直さずにそのまま投げる。
 */
export async function requestWhenFree(send: () => Promise<string>, opts: RequestWhenFreeOptions): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    }
    catch (e) {
      if (!isPortBusy(e)) throw e
      const exhausted = (opts.maxRetries !== undefined && attempt >= opts.maxRetries)
        || (opts.deadline !== undefined && Date.now() + opts.intervalMs > opts.deadline)
      if (exhausted) throw opts.giveUp ? opts.giveUp(e as Error) : e
      await new Promise(resolve => setTimeout(resolve, opts.intervalMs))
      if (opts.isCancelled?.()) throw e
    }
  }
}
