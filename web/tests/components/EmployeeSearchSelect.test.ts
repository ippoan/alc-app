import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import EmployeeSearchSelect from '~/components/EmployeeSearchSelect.vue'

// 乗務員フィルタの打ち込み絞り込み (Refs #333)。本番テナントは 397 名いるため
// <select> では探せない。値は employee.id のまま、表示だけ氏名 (社員番号) にする。

const EMPLOYEES = [
  { id: 'emp-1', tenant_id: 't-1', code: '001', name: '松江 寛人' },
  { id: 'emp-2', tenant_id: 't-1', code: null, name: '青井 健' },
  { id: 'emp-3', tenant_id: 't-1', code: '003', name: '青山 太郎' },
]

async function mountSelect(modelValue = '', employees: any[] = EMPLOYEES) {
  return await mountSuspended(EmployeeSearchSelect, { props: { modelValue, employees } })
}

const input = (w: any) => w.find('[data-testid="employee-search-input"]')
const options = (w: any) => w.findAll('[data-testid="employee-search-option"]')

describe('EmployeeSearchSelect', () => {
  it('focus で全候補を出す', async () => {
    const wrapper = await mountSelect()
    await input(wrapper).trigger('focus')
    expect(options(wrapper).length).toBe(3)
    wrapper.unmount()
  })

  it('名前の部分一致で絞れる', async () => {
    const wrapper = await mountSelect()
    await input(wrapper).setValue('青')
    expect(options(wrapper).map((o: any) => o.text())).toEqual(['青井 健', '003 - 青山 太郎'])
    wrapper.unmount()
  })

  it('社員番号の部分一致で絞れる (大文字小文字は無視)', async () => {
    const wrapper = await mountSelect('', [...EMPLOYEES, { id: 'emp-4', tenant_id: 't-1', code: 'AB9', name: '本田 一' }])
    await input(wrapper).setValue('001')
    expect(options(wrapper).map((o: any) => o.text())).toEqual(['001 - 松江 寛人'])
    await input(wrapper).setValue('ab')
    expect(options(wrapper).map((o: any) => o.text())).toEqual(['AB9 - 本田 一'])
    wrapper.unmount()
  })

  it('候補は最大 10 件までしか出さない', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `emp-${i}`, tenant_id: 't-1', code: `${i}`, name: `乗務員 ${i}`,
    }))
    const wrapper = await mountSelect('', many)
    await input(wrapper).trigger('focus')
    expect(options(wrapper).length).toBe(10)
    wrapper.unmount()
  })

  it('候補クリックで employee.id を確定し、入力欄に氏名と社員番号が残る', async () => {
    const wrapper = await mountSelect()
    await input(wrapper).setValue('青井')
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['emp-2'])
    expect((input(wrapper).element as HTMLInputElement).value).toBe('青井 健')
    expect(options(wrapper).length).toBe(0)
    wrapper.unmount()
  })

  it('↑↓ でハイライトし Enter で確定する', async () => {
    const wrapper = await mountSelect()
    const el = input(wrapper)
    await el.trigger('focus')
    await el.trigger('keydown', { key: 'ArrowDown' })
    await el.trigger('keydown', { key: 'ArrowDown' })
    await el.trigger('keydown', { key: 'ArrowDown' })
    await el.trigger('keydown', { key: 'ArrowUp' })
    await el.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['emp-2'])
    expect((input(wrapper).element as HTMLInputElement).value).toBe('青井 健')
    wrapper.unmount()
  })

  it('Escape で候補が閉じ、↓ で開き直せる', async () => {
    const wrapper = await mountSelect()
    const el = input(wrapper)
    await el.trigger('focus')
    await el.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="employee-search-menu"]').exists()).toBe(false)
    await el.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('[data-testid="employee-search-menu"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('入力を空にすると未選択 (全乗務員) に戻る', async () => {
    const wrapper = await mountSelect('emp-1')
    expect((input(wrapper).element as HTMLInputElement).value).toBe('001 - 松江 寛人')
    await input(wrapper).setValue('')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([''])
    wrapper.unmount()
  })

  it('クリアボタンで未選択 (全乗務員) に戻る', async () => {
    const wrapper = await mountSelect('emp-1')
    await wrapper.find('[data-testid="employee-search-clear"]').trigger('mousedown')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([''])
    expect((input(wrapper).element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('一致 0 件なら「該当なし」を出す', async () => {
    const wrapper = await mountSelect()
    await input(wrapper).setValue('居ない人')
    expect(options(wrapper).length).toBe(0)
    expect(wrapper.find('[data-testid="employee-search-empty"]').text()).toBe('該当なし')
    wrapper.unmount()
  })

  it('確定していない打ちかけの文字は blur で捨てる (表示と絞り込みを一致させる)', async () => {
    const wrapper = await mountSelect('emp-1')
    const el = input(wrapper)
    await el.trigger('focus')
    await el.setValue('青')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([''])
    await el.trigger('blur')
    expect((input(wrapper).element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('乗務員一覧が届く前は候補を開かない (「該当なし」を出さない)', async () => {
    const wrapper = await mountSelect('', [])
    await input(wrapper).trigger('focus')
    expect(wrapper.find('[data-testid="employee-search-menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('乗務員一覧が後から届いたら選択中の氏名を表示する', async () => {
    const wrapper = await mountSelect('emp-1', [])
    expect((input(wrapper).element as HTMLInputElement).value).toBe('')
    await wrapper.setProps({ employees: EMPLOYEES })
    expect((input(wrapper).element as HTMLInputElement).value).toBe('001 - 松江 寛人')
    wrapper.unmount()
  })
})
