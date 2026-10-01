/**
 * backend へ送るトークンの選び方 (Refs ippoan/alc-app#387)。
 *
 * # 規則は 1 つ
 *
 * **その送信で使える端末の鍵のトークンに claim `dev_device` があれば、管理者のトークンより
 * 先にそれを使う。無ければ今までの優先順位 (管理者 → 端末) のまま。**
 *
 * dev端末 (開発用の鍵。本番環境でのテスト用) の記録は、端末の鍵の経路
 * (auth-worker `/device-data-proxy`) を通ったときだけ dev の印が付く。管理者ログインが
 * 残ったブラウザが管理者のトークンで送ると `/alc-proxy` を通り、**印の無い = 本番の行**に
 * なる。それを防ぐのがこの規則で、決定点はすべて {@link usesAdminToken} か、その上に
 * 乗った {@link selectSendToken} を通す (条件を決定点ごとに書き写さない)。
 *
 * # 「dev の印」は同期で読む
 *
 * 管理者の全リクエストに端末トークン取得の待ち (CoreS3 の探索で最大 3 秒) を足さないため、
 * 「この端末の鍵は dev」という事実は**端末のトークンが実際に取れたとき**に
 * {@link noteDeviceToken} で記録し、規則はその印 ({@link isDevDevice}) だけを見る。
 * 印がまだ無い (トークンを一度も取れていない) あいだは今までの優先順位のまま動く。
 *
 * # 印は reload をまたいで残す
 *
 * 印が memory だけだと、reload の直後〜端末のトークンを取り直すまでのあいだ、管理者ログインの
 * ある dev端末の書き込みが管理者のトークンで出て本番の行になる。だから印は localStorage にも
 * 持ち、**起動時 (この module の読み込み時) に同期で読む**。
 *
 * - dev の claim を持つトークンが取れた → 立てる (memory + localStorage)
 * - dev の claim を**持たない**トークンが取れた → 消す (memory + localStorage)。鍵の dev の印が
 *   外された端末が dev のまま残らないように
 * - トークンを捨てた (`null`。鍵を抜いた等) → memory の印だけ下ろす。**localStorage は触らない**
 *   — 「取れなかった」と「dev でなくなった」は別のことで、次の起動ではまた dev として始める
 * - 画面から外した ({@link clearDevDeviceMark}) → 消す (memory + localStorage)
 *
 * localStorage が使えない環境 (SSR・private mode・容量超過) では memory の印だけで動く。
 *
 * # 署名は検証しない
 *
 * ここは「どのトークンを付けるか」を決めるだけで、検証は auth-worker がやる。
 * 読めないトークンは dev でない側 (= 今までの挙動) に倒れる。
 */
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client'

/**
 * 端末の鍵の種類。`api.ts` の getter 3 本と 1 対 1 —
 * キオスク (CoreS3 / 端末登録) / 運行管理者席 (VoiceS3R) / 血圧測定台 (ATOM S3)。
 */
export type DeviceTokenKind = 'kiosk' | 'manager-device' | 'bp-station'

/** 保存先の key (kind ごと)。値は dev のとき `'1'`、dev でなければ key ごと消す。 */
function storageKey(kind: DeviceTokenKind): string {
  return `alc_dev_device_${kind}`
}

/** 保存してある印を読む。localStorage が使えなければ「印なし」。 */
function readStoredMark(kind: DeviceTokenKind): boolean {
  try {
    return localStorage.getItem(storageKey(kind)) === '1'
  }
  catch {
    return false
  }
}

/** 印を保存する / 消す。保存できなくても、この起動のあいだは memory の印で動く。 */
function writeStoredMark(kind: DeviceTokenKind, dev: boolean): void {
  try {
    if (dev) localStorage.setItem(storageKey(kind), '1')
    else localStorage.removeItem(storageKey(kind))
  }
  catch {
    // private mode・容量超過など。トークンの選択を落とさない
  }
}

// 起動時に保存してある印を同期で読む — 端末のトークンをまだ取っていなくても、前回 dev だった
// 端末は dev として始まる
const devMarks: Record<DeviceTokenKind, boolean> = {
  'kiosk': readStoredMark('kiosk'),
  'manager-device': readStoredMark('manager-device'),
  'bp-station': readStoredMark('bp-station'),
}

/** 端末のトークンの payload に `dev_device === true` があるか (署名は見ない)。 */
export function isDevDeviceToken(token: string | null | undefined): boolean {
  if (!token) return false
  const payload = decodeJwtPayloadFromToken(token) as { dev_device?: unknown } | null
  return payload?.dev_device === true
}

/**
 * 端末のトークンの cache が書き換わったら呼ぶ (取れたとき / 捨てたとき)。
 * 取れたトークンが dev なら印を立て、dev でないトークン・`null` (鍵を抜いた等) なら下ろす。
 * **保存してある印を書き換えるのはトークンが取れたときだけ** (`null` では触らない)。
 */
export function noteDeviceToken(kind: DeviceTokenKind, token: string | null): void {
  const dev = isDevDeviceToken(token)
  devMarks[kind] = dev
  if (token) writeStoredMark(kind, dev)
}

/**
 * その種類の dev の印を外す (memory + localStorage)。{@link noteDeviceToken} が dev でない
 * トークンを取ったときと同じ消し方。
 *
 * dev の鍵を**抜いたあと**の PC を管理者として使い直すための操作 — 鍵を抜いただけでは
 * 保存した印が残り (「取れなかった」と「dev でなくなった」は別)、管理者ログインがあっても
 * 管理者のトークンで送らなくなる。**dev の鍵が挿さったままなら、次にトークンを取った時点で
 * また印が立つ** (印を決めるのは取れたトークンで、この関数は鍵の側を変えない)。
 */
export function clearDevDeviceMark(kind: DeviceTokenKind): void {
  devMarks[kind] = false
  writeStoredMark(kind, false)
}

/**
 * その種類の端末の鍵が dev だと分かっているか (同期。分かっていなければ false)。
 * 起動直後は前回保存した印、以後は最後に取れた (または捨てた) トークンで決まる。
 */
export function isDevDevice(kind: DeviceTokenKind): boolean {
  return devMarks[kind]
}

/**
 * **規則の本体。** この送信を管理者のトークンで送るか。
 *
 * 管理者のトークンがあり、かつこの送信が使うはずの端末の鍵が dev でないときだけ true。
 * `kind` には**その決定点がもともと使うはずだった端末トークン**の種類を渡す
 * (`scope: 'manager-device'` なら運行管理者席、既定ならキオスク)。
 */
export function usesAdminToken(adminToken: string | null | undefined, kind: DeviceTokenKind): boolean {
  return !!adminToken && !isDevDevice(kind)
}

/**
 * 送信に付けるトークンを 1 つ選ぶ ({@link usesAdminToken} の上に乗せた形)。
 *
 * - 規則が管理者を選べば管理者のトークン
 * - それ以外は端末のトークン (getter が無い・取れないなら `null`)
 *
 * **dev端末でトークンが取れなかったときに管理者のトークンへ戻さない。** 戻すと、その送信だけ
 * 本番の行になる。「管理者ログインが無い端末」と同じ扱い (呼び出し側の未認証の分岐) にする。
 */
export async function selectSendToken(
  adminToken: string | null | undefined,
  kind: DeviceTokenKind,
  getDeviceToken: (() => Promise<string | null>) | null | undefined,
): Promise<string | null> {
  if (usesAdminToken(adminToken, kind)) return adminToken as string
  return getDeviceToken ? await getDeviceToken() : null
}
