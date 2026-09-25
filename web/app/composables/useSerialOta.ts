/**
 * キオスクが USB でつながった端末をシリアル経由で更新する (シリアル OTA、
 * Refs ippoan/alc-app-s3#279)。
 *
 * Atom VoiceS3R の `atoms3-timecard` `station` ビルドは LAN も Wi-Fi も持たず、USB で
 * 運行者 PC につながっている。管理者が /device/setup で「最新にする」を押すと、recorder が
 * キオスクの購読 WS (`useTimecardWatch`) に `{"type":"serial_ota","target":…}` を送る。
 * キオスクはここで Pages から版とイメージを取り、Web Serial で動作中の端末の app へ流し込む。
 *
 * # 契約 (端末側は alc-app-s3 の firmware。行は `OTA ` で始まるものだけを見る)
 *
 * 1. `OTA SERIAL <size> <flavor>` → `OTA READY <chunk>` / `OTA ERR <reason>`
 * 2. 生のバイト列を `<chunk>` ずつ。**`OTA ACK <累計>` を受けてから次を送る**
 * 3. 最後のチャンクの後は `complete()` (検証) の結果 `OTA OK` / `OTA ERR verify`。
 *    `OTA OK` の約 500 ms 後に端末は再起動する
 * 4. 再接続後に `DEVICE` → `DEVICE timecard VER=<ver> FLAVOR=<flavor>`。
 *    FLAVOR が期待どおりなら `OTA CONFIRM` → `OTA CONFIRMED`
 *    (10 分以内に確定しなければ端末は元のスロットへ戻る)
 *
 * # 何を信じるか
 *
 * - **URL と版はメッセージから受け取らない。** 合図は `target` の語だけで、URL はこのファイルに
 *   固定した allowlist ({@link SERIAL_OTA_TARGETS}) から引く。表に無い target は無視する
 * - **VER は「更新するか」の判定にだけ使う。確定の条件は FLAVOR だけ。** Pages は CDN の
 *   max-age が 600 秒で、反映直後は manifest とイメージが一時的に食い違うことがあるため
 *   (manifest の版とイメージの中身がずれても、焼いたものが同じ機種のビルドなら確定してよい)
 *
 * ポートは `useVeinSerial` (claimant `timecard`) が握っているものを借りる。2 本目の
 * claimant も reader も立てない。
 */

/** 対象の端末 1 種の固定情報 */
interface SerialOtaTarget {
  manifestUrl: string
  appUrl: string
  /** `DEVICE` 応答の `FLAVOR=` と、`OTA SERIAL` に載せる語 */
  flavor: string
}

/**
 * 合図の `target` → 取りに行く先の allowlist。**URL はここにしか書かない。**
 * 合図 (WS のメッセージ) から URL や版を受け取ると、recorder を経由して任意のイメージを
 * 焼かせる口になるため。
 */
export const SERIAL_OTA_TARGETS: Readonly<Record<string, SerialOtaTarget>> = {
  'timecard-station': {
    manifestUrl: 'https://ippoan.github.io/alc-app-s3/manifest-timecard-station.json',
    appUrl: 'https://ippoan.github.io/alc-app-s3/firmware/alc-hub-atoms3-timecard-station-app.bin',
    flavor: 'timecard-station',
  },
}

/** これ未満のイメージは壊れている (Pages の 404 ページ等) とみなして書かない */
export const MIN_IMAGE_BYTES = 256 * 1024

/** `DEVICE` の応答待ち */
const DEVICE_TIMEOUT_MS = 5_000
/** `OTA SERIAL` → `OTA READY`。端末は esp_ota_begin でイメージ長ぶんを消去するので長めに待つ */
const BEGIN_TIMEOUT_MS = 60_000
/** 1 チャンク → `OTA ACK`。端末側の無受信タイムアウト (10 秒) より長くして、端末の ERR を先に受ける */
const ACK_TIMEOUT_MS = 15_000
/** 最後のチャンク → `OTA OK` (イメージの検証を含む) */
const VERIFY_TIMEOUT_MS = 60_000
/** `OTA OK` → 再接続。arbiter は 10 秒ごとに再スキャンする */
const RECONNECT_TIMEOUT_MS = 90_000
/** `OTA CONFIRM` → `OTA CONFIRMED` */
const CONFIRM_TIMEOUT_MS = 10_000
/** 結果 (done / failed) を画面に出しておく時間 */
export const RESULT_DISPLAY_MS = 5_000

/** 失敗行の接頭辞 (`OTA ERR <reason>`)。`ERR <先頭トークン>` の形ではないので明示する */
const OTA_ERR = 'OTA ERR'

export type SerialOtaState =
  | { kind: 'idle' }
  | { kind: 'downloading' }
  | { kind: 'writing', pct: number }
  | { kind: 'rebooting' }
  | { kind: 'confirming' }
  | { kind: 'done', ver: string }
  | { kind: 'failed', reason: string }

/** `DEVICE timecard VER=… FLAVOR=…` から VER と FLAVOR を取り出す (無ければ null) */
export function parseDeviceLine(line: string): { ver: string | null, flavor: string | null } {
  const field = (key: string): string | null => {
    const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))
    return m ? m[1]! : null
  }
  return { ver: field('VER'), flavor: field('FLAVOR') }
}

// シングルトン: 1 台の PC で同時に走る OTA は 1 本
const state = ref<SerialOtaState>({ kind: 'idle' })
let running = false
let resultTimer: ReturnType<typeof setTimeout> | null = null

export function useSerialOta() {
  const link = useVeinSerial()
  /**
   * 待機画面へ戻るのを待っている target。呼び出し元 (キオスク) ごとに持つ —
   * 画面が外れたら一緒に捨てる (管理者が押し直す)
   */
  let queued: string | null = null

  async function readDevice(): Promise<{ ver: string | null, flavor: string | null }> {
    return parseDeviceLine(await link.request('DEVICE', 'DEVICE ', DEVICE_TIMEOUT_MS))
  }

  async function fetchOk(url: string): Promise<Response> {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }

  /** 接続の有無が `want` になるのを `deadline` (Date.now() の値) まで待つ */
  function waitForConnected(want: boolean, deadline: number): Promise<boolean> {
    if (link.isConnected.value === want) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      // 真偽値なので、変わった時点で `want` になっている
      const stop = watch(link.isConnected, () => finish(true), { flush: 'sync' })
      const timer = setTimeout(() => finish(false), deadline - Date.now())
      function finish(ok: boolean): void {
        clearTimeout(timer)
        stop()
        resolve(ok)
      }
    })
  }

  /** `OTA OK` の後、いったん切れてからつながり直すのを待つ */
  async function waitForReconnect(): Promise<boolean> {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS
    return await waitForConnected(false, deadline) && await waitForConnected(true, deadline)
  }

  /** 結果を数秒出してから idle に戻す */
  function settle(next: SerialOtaState): void {
    state.value = next
    if (resultTimer) clearTimeout(resultTimer)
    resultTimer = setTimeout(() => {
      resultTimer = null
      state.value = { kind: 'idle' }
    }, RESULT_DISPLAY_MS)
  }

  async function flash(target: SerialOtaTarget): Promise<void> {
    // 更新が要るかは画面に出さずに調べる (最新のキオスクで毎回画面が点滅しないように)
    const device = await readDevice()
    // station 以外 (vein 等) がつながっているキオスクは対象外
    if (device.flavor !== target.flavor) return
    const manifest = await (await fetchOk(target.manifestUrl)).json() as { version?: unknown }
    if (typeof manifest.version !== 'string') throw new Error('manifest has no version')
    if (manifest.version === device.ver) return

    state.value = { kind: 'downloading' }
    const image = new Uint8Array(await (await fetchOk(target.appUrl)).arrayBuffer())
    if (image.length < MIN_IMAGE_BYTES) throw new Error(`image too small (${image.length} B)`)

    state.value = { kind: 'writing', pct: 0 }
    const ready = await link.request(`OTA SERIAL ${image.length} ${target.flavor}`, 'OTA READY', BEGIN_TIMEOUT_MS, OTA_ERR)
    const chunk = Number.parseInt(ready.slice('OTA READY'.length).trim(), 10)
    if (!(chunk > 0)) throw new Error(`bad chunk size (${ready})`)

    for (let sent = 0; sent < image.length;) {
      const end = Math.min(sent + chunk, image.length)
      const bytes = image.subarray(sent, end)
      if (end < image.length) {
        // ACK を受けてから次を送る (端末の flash 書き込みを追い越さない)
        const ack = await link.request(bytes, 'OTA ACK', ACK_TIMEOUT_MS, OTA_ERR)
        const acked = Number.parseInt(ack.slice('OTA ACK'.length).trim(), 10)
        if (acked !== end) throw new Error(`ack mismatch (${acked} != ${end})`)
      }
      else {
        // 最後のチャンクは ACK の後に検証の結果が来る。ACK を待って登録し直すと、同じ読み取りに
        // 入った `OTA OK` を取りこぼしうるので、最初から `OTA OK` を待つ
        await link.request(bytes, 'OTA OK', VERIFY_TIMEOUT_MS, OTA_ERR)
      }
      sent = end
      state.value = { kind: 'writing', pct: Math.floor((sent * 100) / image.length) }
    }

    state.value = { kind: 'rebooting' }
    if (!(await waitForReconnect())) throw new Error('reconnect timeout')

    state.value = { kind: 'confirming' }
    const after = await readDevice()
    // 確定の条件は FLAVOR だけ (VER は Pages の食い違いがありうるので見ない)。
    // 確定しなければ端末は 10 分後に元のスロットへ戻る
    if (after.flavor !== target.flavor) throw new Error(`flavor mismatch after reboot (${after.flavor})`)
    await link.request('OTA CONFIRM', 'OTA CONFIRMED', CONFIRM_TIMEOUT_MS, OTA_ERR)
    settle({ kind: 'done', ver: after.ver ?? '' })
  }

  /**
   * target の端末を更新する。allowlist に無い target・端末がつながっていない・
   * 別の OTA が走っている、のどれかなら何もしない。
   */
  async function run(target: string): Promise<void> {
    const entry = Object.hasOwn(SERIAL_OTA_TARGETS, target) ? SERIAL_OTA_TARGETS[target]! : null
    if (!entry || running || !link.isConnected.value) return
    running = true
    try {
      await flash(entry)
    }
    catch (e) {
      const reason = (e as Error).message
      // 更新が要るかを調べている段階 (idle のまま) で失敗したときは画面に出さない
      if (state.value.kind === 'idle') console.warn(`[SERIAL_OTA] skipped: ${reason}`)
      else settle({ kind: 'failed', reason })
    }
    finally {
      running = false
    }
  }

  /**
   * 合図を受けたが今は実行できない (点呼・打刻の途中) ときに預ける。
   * allowlist に無い target は預けない。
   */
  function enqueue(target: string): void {
    if (Object.hasOwn(SERIAL_OTA_TARGETS, target)) queued = target
  }

  /** 預けた target があれば走らせる (待機画面に戻ったときに呼ぶ) */
  async function runQueued(): Promise<void> {
    if (queued === null) return
    const target = queued
    queued = null
    await run(target)
  }

  return {
    state: readonly(state),
    run,
    enqueue,
    runQueued,
  }
}
