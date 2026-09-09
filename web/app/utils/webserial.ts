/**
 * WebSerial (`navigator.serial`) が使えるかの判定。
 *
 * 同じ式が composable ごとに複製されていたため 1 本にまとめた
 * (Refs ippoan/alc-app#182)。判定はここだけに置き、WebSerial の
 * 調停を 1 か所へ寄せる後続の変更もこの関数を起点にする。
 *
 * SSR では `navigator` 自体が無いので false を返す。
 */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}
