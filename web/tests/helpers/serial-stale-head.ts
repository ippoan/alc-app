/**
 * 開いた直後の断片 (Refs ippoan/alc-app#353)。
 *
 * 実機はポートを開いた瞬間に、端末側に溜まっていた出力の切れ端を先に吐く (行の途中から
 * 読み始める)。arbiter (`useSerialArbiter`) は最初の改行までをそれとして捨てるので、
 * モックポートも `getReader()` のたびにこの 1 本を先頭 chunk として積む。積まないと、
 * 各テストが渡す `DEVICE ...` の行そのものが断片として捨てられる。
 */
export const STALE_HEAD = 'stale tail of an earlier line\r\n'

/** `getReader()` ごとに queue の先頭へ積む断片の chunk */
export function staleHeadChunk(): { value: Uint8Array; done: boolean } {
  return { value: new TextEncoder().encode(STALE_HEAD), done: false }
}
