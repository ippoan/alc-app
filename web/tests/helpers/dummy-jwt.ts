/**
 * テスト用のダミー JWT を組み立てる (署名は固定の文字列。トークンの選択・振り分けは署名を見ない)。
 * 値はすべてその場で作った架空のもの。
 */
export function dummyJwt(payload: unknown): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

/** dev端末の鍵で出た device JWT (claim `dev_device: true`)。 */
export function devDeviceJwt(sub = 'dev-device'): string {
  return dummyJwt({ sub, tenant_id: 't1', role: 'device-kiosk', aud: 'device', dev_device: true })
}

/** dev でない端末の鍵で出た device JWT (claim 無し)。 */
export function plainDeviceJwt(sub = 'plain-device'): string {
  return dummyJwt({ sub, tenant_id: 't1', role: 'device-kiosk', aud: 'device' })
}

/** 管理者ログインの browser JWT (`aud` 無し)。 */
export function browserJwt(): string {
  return dummyJwt({ sub: 'u1', tenant_id: 't1', email: 'a@example.com', role: 'admin' })
}
