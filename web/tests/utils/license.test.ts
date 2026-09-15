import { describe, it, expect } from 'vitest'
import {
  parseLicenseIssueDate,
  parseLicenseExpiryDate,
  checkLicenseExpiry,
  formatExpiryDate,
  formatDateForInput,
  checkLicenseExpiryFromString,
  expiryTone,
  EXPIRY_TONE_CLASS,
} from '~/utils/license'

describe('license', () => {
  // EF 2F01 サンプル: Tag(45) Len(0B) Ver(3bytes) Issue(20250115) Expiry(20280115) Tag46+data
  // hex: "450B 303030 20250115 20280115 46030000FF"
  const sampleHex = '450B30303020250115202801154603000000'

  describe('parseLicenseIssueDate', () => {
    it('有効な hex から交付年月日を抽出', () => {
      const date = parseLicenseIssueDate(sampleHex)
      expect(date).not.toBeNull()
      expect(date!.getFullYear()).toBe(2025)
      expect(date!.getMonth()).toBe(0) // January = 0
      expect(date!.getDate()).toBe(15)
    })

    it('短い hex は null', () => {
      expect(parseLicenseIssueDate('')).toBeNull()
      expect(parseLicenseIssueDate('450B3030')).toBeNull()
    })

    it('NaN な日付文字列は null', () => {
      // chars 10-17 の year が完全に非数値
      expect(parseLicenseIssueDate('450B303030XXXX0115202801154603')).toBeNull()
    })

    it('不正な日付は null', () => {
      // month=13
      expect(parseLicenseIssueDate('450B303030202513151234')).toBeNull()
    })

    it('範囲外の年は null', () => {
      // year=1900
      expect(parseLicenseIssueDate('450B30303019000115202801154603')).toBeNull()
    })

    it('day > 31 は null', () => {
      // day=32: "450B30303020250132..." — chars 10-17 = "20250132"
      expect(parseLicenseIssueDate('450B303030202501322028011546')).toBeNull()
    })
  })

  describe('parseLicenseExpiryDate', () => {
    it('有効な hex から有効期限を抽出', () => {
      const date = parseLicenseExpiryDate(sampleHex)
      expect(date).not.toBeNull()
      expect(date!.getFullYear()).toBe(2028)
      expect(date!.getMonth()).toBe(0)
      expect(date!.getDate()).toBe(15)
    })

    it('短い hex は null', () => {
      expect(parseLicenseExpiryDate('')).toBeNull()
      expect(parseLicenseExpiryDate('450B303030202501')).toBeNull()
    })

    it('NaN な日付文字列は null', () => {
      // chars 18-25 の year が完全に非数値
      expect(parseLicenseExpiryDate('450B303030202501XXXXXXXX4603')).toBeNull()
    })

    it('不正な日付は null', () => {
      // day=00
      expect(parseLicenseExpiryDate('450B303030202501152028010046')).toBeNull()
    })

    it('year < 2000 は null', () => {
      expect(parseLicenseExpiryDate('450B303030202501151999011546')).toBeNull()
    })

    it('day > 31 は null', () => {
      expect(parseLicenseExpiryDate('450B303030202501152028013246')).toBeNull()
    })
  })

  describe('checkLicenseExpiry', () => {
    it('有効期限が十分先なら valid', () => {
      const future = new Date()
      future.setFullYear(future.getFullYear() + 1)
      expect(checkLicenseExpiry(future)).toBe('valid')
    })

    it('有効期限が 30 日以内なら expiring_soon', () => {
      const soon = new Date()
      soon.setDate(soon.getDate() + 15)
      expect(checkLicenseExpiry(soon)).toBe('expiring_soon')
    })

    it('有効期限切れなら expired', () => {
      const past = new Date()
      past.setDate(past.getDate() - 1)
      expect(checkLicenseExpiry(past)).toBe('expired')
    })

    it('カスタム warningDays', () => {
      const date = new Date()
      date.setDate(date.getDate() + 5)
      expect(checkLicenseExpiry(date, 3)).toBe('valid')
      expect(checkLicenseExpiry(date, 10)).toBe('expiring_soon')
    })

    it('当日が warningDays 境界 (ちょうど30日後)', () => {
      const date = new Date()
      const today = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      today.setDate(today.getDate() + 30)
      expect(checkLicenseExpiry(today)).toBe('expiring_soon')
    })
  })

  describe('formatExpiryDate', () => {
    it('YYYY/MM/DD 形式にフォーマット', () => {
      expect(formatExpiryDate(new Date(2028, 0, 15))).toBe('2028/01/15')
    })

    it('1桁月日をゼロ埋め', () => {
      expect(formatExpiryDate(new Date(2025, 2, 5))).toBe('2025/03/05')
    })
  })

  describe('formatDateForInput', () => {
    it('YYYY-MM-DD 形式にフォーマット', () => {
      expect(formatDateForInput(new Date(2028, 0, 15))).toBe('2028-01-15')
    })
  })

  describe('checkLicenseExpiryFromString', () => {
    it('有効な日付文字列', () => {
      const future = new Date()
      future.setFullYear(future.getFullYear() + 1)
      const str = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`
      expect(checkLicenseExpiryFromString(str)).toBe('valid')
    })

    it('不正な文字列は expired', () => {
      expect(checkLicenseExpiryFromString('')).toBe('expired')
      expect(checkLicenseExpiryFromString('invalid')).toBe('expired')
    })

    it('カスタム warningDays', () => {
      const date = new Date()
      date.setDate(date.getDate() + 5)
      const str = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      expect(checkLicenseExpiryFromString(str, 3)).toBe('valid')
    })
  })

  // 免許証 3 か所 + 車検 2 か所の共有表 (ユーザーの判断、Refs ippoan/alc-app-s3#110)
  describe('expiryTone', () => {
    it('4 分岐: expired=red / expiring_soon=yellow / valid=green / null=gray', () => {
      expect(expiryTone('expired')).toEqual({ tone: 'red', label: '期限切れ' })
      expect(expiryTone('expiring_soon')).toEqual({ tone: 'yellow', label: '期限間近' })
      expect(expiryTone('valid')).toEqual({ tone: 'green', label: '有効' })
      expect(expiryTone(null)).toEqual({ tone: 'gray', label: '未登録' })
    })
  })

  describe('EXPIRY_TONE_CLASS', () => {
    // 置き換え前の各画面のクラスと同じであることを固定する
    // (LicenseRegistration.vue の pill / NfcStatus.vue の文 / NormalMeasurement.vue の帯)
    it('pill は LicenseRegistration.vue の置き換え前のクラスと同じ', () => {
      expect(EXPIRY_TONE_CLASS.pill.green).toBe('bg-green-100 text-green-800')
      expect(EXPIRY_TONE_CLASS.pill.yellow).toBe('bg-amber-100 text-amber-800')
      expect(EXPIRY_TONE_CLASS.pill.red).toBe('bg-red-100 text-red-800')
      expect(EXPIRY_TONE_CLASS.pill.gray).toBe('bg-gray-100 text-gray-500')
    })

    it('text は NfcStatus.vue の置き換え前のクラスと同じ (rounded-lg 込み)', () => {
      expect(EXPIRY_TONE_CLASS.text.red).toBe('bg-red-100 text-red-700 rounded-lg')
      expect(EXPIRY_TONE_CLASS.text.yellow).toBe('bg-amber-100 text-amber-700 rounded-lg')
    })

    it('banner は NormalMeasurement.vue の置き換え前のクラスと同じ (border は別トークン)', () => {
      // 元は `bg-red-50 border border-red-200 ... text-red-700` — `border` はここでは持たず
      // wrapper 側の共通クラスに残す (トークンの集合として同じであればよい)
      expect(EXPIRY_TONE_CLASS.banner.red).toBe('bg-red-50 border-red-200 text-red-700')
      expect(EXPIRY_TONE_CLASS.banner.yellow).toBe('bg-amber-50 border-amber-200 text-amber-700')
    })
  })
})
