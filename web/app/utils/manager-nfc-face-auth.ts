/**
 * 運行管理者の入口で、NFC で本人が決まったあとに顔認証へ進むか。
 * false の間は NFC ではログインせず、「この端末の指を足す」を出して指静脈で入らせる
 * (顔認証はいったん外した。コードは残してあるので、true に戻せば NFC → 顔認証の流れに戻る)。
 */
export const MANAGER_NFC_FACE_AUTH = false
