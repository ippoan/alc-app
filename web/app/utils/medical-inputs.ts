/**
 * 血圧計の表示 ON/OFF (Refs ippoan/alc-app#238 / ippoan/alc-app-s3#135)。
 *
 * 血圧計 (ニプロ NBP-1BLE) の受信・送信ロジックは残したまま、画面表示だけを
 * このフラグで隠す。将来オプションとして表示単位を選べるようにする計画だが、
 * 単位 (テナント単位か端末単位か等) は未確定のため、今は定数 1 つで一律に隠す。
 */
export const SHOW_BLOOD_PRESSURE = false
