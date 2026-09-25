/**
 * IndexedDB を開く共通の口 (Refs ippoan/vein-match#20)。
 *
 * `indexedDB.open` を Promise にするだけの薄い関数。**store の作り方は呼び出し側が
 * `upgrade` で渡す** (DB ごとに違うのはそこだけなので)。
 *
 * 今は `vein-db.ts` だけが使う。既存の 4 本 (`face-db.ts` / `offline-queue.ts` /
 * `timecard-card-db.ts` / `video-store.ts`) はそれぞれ同じ形の `openDb()` を持っているが、
 * 差し替えは別の変更で行う (ここで 5 本目の複製を作らないための受け皿)。
 */
export function openIdb(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => upgrade(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
