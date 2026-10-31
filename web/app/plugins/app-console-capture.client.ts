/**
 * 画面の診断の行をコンソールから送り待ちへ写し始める (Refs ippoan/alc-app#558)。
 * 起動直後の行 (`[RELOAD-DETECT] page loaded` など) も拾うよう、plugin で一番先に包む
 */
import { installAppConsoleCapture } from '~/utils/appConsoleCapture'

export default defineNuxtPlugin({
  name: 'app-console-capture',
  enforce: 'pre',
  setup() {
    installAppConsoleCapture()
  },
})
