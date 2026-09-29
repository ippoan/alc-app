import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

// Set up fake-indexeddb as globals
globalThis.indexedDB = new IDBFactory()
globalThis.IDBKeyRange = IDBKeyRange

// 指静脈の照合データ同期は TenkoKiosk の mount ごとに `void syncVeinTemplates()` で走る (#380)。
// 同期が関心事でないテストでは api mock に getVeinTemplates が無く、失敗の console.warn が
// mount ごとに出る。完了を待たれないその出力が vitest の onUserConsoleLog rpc に流れ、
// worker の後片付けと競って `EnvironmentTeardownError` になる (全体を並列に回したときだけ・#385)。
// **発生源を止める**: 既定では同期しない。同期そのものを見るテストは `vi.unmock` で本物に戻す。
vi.mock('~/utils/vein-identify', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-identify')>()),
  syncVeinTemplates: vi.fn(async () => false),
}))
