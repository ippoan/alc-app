/**
 * USB シリアルの 1 行を、`EVT <NAME> <args...>` と JSON (`{…}`) の購読者へ配る。
 *
 * CoreS3 (useCoreS3Serial)・血圧測定台の Atom S3 (useAtomS3Serial)・Vein Station
 * (useVeinSerial) のファームは同じ語彙で行を出す (`EVT NFC_LICENSE …` / `EVT FC1200 …` /
 * `{"type":"alcohol",…}` 等。alc-app-s3 の hub-drivers を共有しているため)。分解と配布は
 * ここ 1 本にして、各端末の利用側は「どの行を配るか」だけを持つ (Refs ippoan/alc-app#436)。
 *
 * 購読者の Set は呼び出し側ごとに 1 組 — 端末ごとのシングルトンとして module の頭で作る。
 */

export type SerialEventHandler = (name: string, args: string[]) => void
export type SerialJsonHandler = (msg: unknown) => void

/** `label` は JSON が壊れていたときの警告の頭 (`[CoreS3]` 等) */
export function createLineDispatch(label: string) {
  const eventHandlers = new Set<SerialEventHandler>()
  const jsonHandlers = new Set<SerialJsonHandler>()

  /**
   * `EVT <NAME> <args...>` を名前と引数に割って配る。**絞り込みはしない** — どの EVT を
   * 使うかは購読側が名前で決める (`key=value` の値は useCoreS3Serial の `evtArg` で読む)
   */
  function dispatchEvent(line: string): void {
    // 'EVT ' の 4 文字を落とし、最初の空白までが名前
    const sep = line.indexOf(' ', 4)
    const name = sep === -1 ? line.slice(4) : line.slice(4, sep)
    const args = sep === -1 ? [] : line.slice(sep + 1).split(' ')
    for (const cb of [...eventHandlers]) cb(name, args)
  }

  /** JSON として読めたら配る。中身は検査しない (端末間で語彙を共有しているため) */
  function dispatchJson(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    }
    catch {
      console.warn(`[${label}] Invalid JSON:`, line)
      return
    }
    for (const cb of [...jsonHandlers]) cb(msg)
  }

  /** `EVT ` で始まる行と `{` で始まる行だけを配る。それ以外 (コマンドの応答等) は捨てる */
  function dispatchLine(line: string): void {
    if (line.startsWith('EVT ')) dispatchEvent(line)
    else if (line.startsWith('{')) dispatchJson(line)
  }

  /** JSON として読めた行を受け取る。返り値を呼ぶと解除できる */
  function onJson(cb: SerialJsonHandler): () => void {
    jsonHandlers.add(cb)
    return () => { jsonHandlers.delete(cb) }
  }

  /** `EVT <NAME> <args...>` を受け取る。返り値を呼ぶと解除できる */
  function onEvent(cb: SerialEventHandler): () => void {
    eventHandlers.add(cb)
    return () => { eventHandlers.delete(cb) }
  }

  return { dispatchEvent, dispatchJson, dispatchLine, onJson, onEvent }
}
