/**
 * operator 印刷 (Refs ippoan/alc-app-s3#38) の純粋ロジック。
 *
 * ブラウザが選んだ PDF を base64 で受け取り、cf-alc-recorder の内部 command
 * endpoint (`POST /tenants/:t/devices/:d/command`) へ流す
 * `print_begin` → `print_data`(chunk)* → `print_end` のコマンド列と forward
 * request を組む。副作用 (fetch) は handler 側 (server/api/print/*)。
 *
 * base64 文字列は **4 文字境界で分割**する。base64 は 4 文字 = 生 3 バイト
 * なので、境界を 4 の倍数に取れば各片が単独で valid base64 になり
 * (firmware の base64_decode が要求する「長さが 4 の倍数」を満たす)、
 * padding は末尾片にしか現れない。raw バイナリを worker で扱わずに済む。
 */

/** 1 チャンクの base64 文字数 (4 の倍数)。生 ~33KB 相当。WS 1MiB 上限内。 */
export const PRINT_CHUNK_B64_CHARS = 44 * 1024

/** recorder command endpoint / auth-worker introspect への forward request。 */
export interface Forward {
  url: string
  init: RequestInit
}

/** 印刷コマンド 1 件 (recorder command payload)。 */
export interface PrintCommand {
  action: 'print_begin' | 'print_data' | 'print_end'
  seq?: number
  chunk?: string
}

/**
 * recorder への forward 先 (service binding は host を無視するが、path は
 * Worker 側 route と一致する必要がある)。**打刻中継 (timecard-relay.ts) と共有** —
 * 2 か所に書くと片方だけ変えたときに静かにずれる。
 */
export const RECORDER_BASE = 'https://alc-recorder.internal'
const AUTH_WORKER_BASE = 'https://auth-worker.internal'

/**
 * base64 文字列を 4 文字境界で分割する (各片が単独で valid base64)。
 * `chunkChars` は 4 の倍数に丸める (最小 4)。空文字列は空配列。
 */
export function splitBase64(pdfBase64: string, chunkChars: number = PRINT_CHUNK_B64_CHARS): string[] {
  const size = Math.max(4, Math.floor(chunkChars / 4) * 4)
  const chunks: string[] = []
  for (let i = 0; i < pdfBase64.length; i += size) {
    chunks.push(pdfBase64.slice(i, i + size))
  }
  return chunks
}

/** `print_begin` → `print_data`(seq,chunk)* → `print_end` のコマンド列を組む。 */
export function buildPrintCommands(base64Chunks: string[]): PrintCommand[] {
  const cmds: PrintCommand[] = [{ action: 'print_begin' }]
  base64Chunks.forEach((chunk, seq) => cmds.push({ action: 'print_data', seq, chunk }))
  cmds.push({ action: 'print_end' })
  return cmds
}

/**
 * recorder の command endpoint への forward request を組む。
 * 認証は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値、recorder が定数時間比較)。
 */
export function buildRecorderCommandForward(input: {
  sharedSecret: string
  tenantId: string
  deviceId: string
  payload: PrintCommand
}): Forward {
  const url = `${RECORDER_BASE}/tenants/${encodeURIComponent(input.tenantId)}/devices/${encodeURIComponent(
    input.deviceId,
  )}/command`
  return {
    url,
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: input.payload }),
    },
  }
}

/** recorder の接続中デバイス一覧 endpoint への forward request を組む。 */
export function buildRecorderDevicesForward(input: { sharedSecret: string; tenantId: string }): Forward {
  return {
    url: `${RECORDER_BASE}/tenants/${encodeURIComponent(input.tenantId)}/devices`,
    init: { method: 'GET', headers: { Authorization: input.sharedSecret } },
  }
}

/**
 * auth-worker `/auth/introspect` 応答のうち server route が見る field。
 *
 * **server/utils/* は Nitro が auto-import する**ので、同じ名前を 2 つの
 * ファイルで export すると片方が黙って無視される。introspect を使う route が
 * 増えてもここ 1 つを使うこと。
 */
export interface IntrospectClaims {
  active?: boolean
  tenant_id?: string
  role?: string
  /** device JWT なら device_id、利用者の JWT ならユーザー識別子。 */
  sub?: string
}

/**
 * JWT の payload から `token_kind` を読む (**署名は検証しない**)。
 *
 * dev-login (ippoan/auth-worker#423) が発行する JWT は `token_kind: "dev"` を持ち、
 * 本番の `logi_auth_token` と同じ鍵で署名されている。auth-worker の
 * read-only enforcement (#433) は **`/alc-proxy` の中**にあるので、
 * **自前で introspect する server route には効かない** (Refs ippoan/alc-app#162)。
 *
 * **署名を検証しなくてよい理由**: この値を見るのは `/auth/introspect` が
 * `active: true` を返した**後**だけ。auth-worker が同じ token の署名・exp・ACL を
 * 検証済みなので、その payload の claim は本物である。JWT_SECRET は要らない
 * (consumer に鍵を配らない #290 の方針は保たれる)。
 *
 * **introspect の応答に `token_kind` が無いのでここで読んでいる。** auth-worker が
 * 応答に足してくれたら、そちらへ寄せてこの関数は消すこと (判定材料は 1 か所が良い)。
 *
 * 読めない token (segment 不足 / base64 不正 / JSON 不正) は null を返す。
 * **その場合 dev 扱いにはしない** — introspect を通った token しかここに来ないため。
 */
export function tokenKindOf(token: string): string | null {
  const seg = token.split('.')[1]
  if (!seg) return null
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(padded)
    // claim に非 ASCII (氏名など) が入りうるので TextDecoder で UTF-8 として読む
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { token_kind?: unknown }
    return typeof payload.token_kind === 'string' ? payload.token_kind : null
  }
  catch {
    return null
  }
}

/** dev-login (`token_kind: "dev"`) の token か。副作用のある route はこれで弾く。 */
export function isDevLoginToken(token: string): boolean {
  return tokenKindOf(token) === 'dev'
}

/**
 * auth-worker `/auth/introspect` への forward request を組む。operator の
 * browser JWT を検証して tenant_id / role を得るのに使う (recorder の auth.ts と
 * 同じ shared secret 認証)。
 */
export function buildIntrospectForward(input: {
  sharedSecret: string
  token: string
  origin: string
}): Forward {
  return {
    url: `${AUTH_WORKER_BASE}/auth/introspect`,
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.token, origin: input.origin }),
    },
  }
}
