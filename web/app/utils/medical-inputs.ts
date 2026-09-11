/**
 * 血圧計の表示 ON/OFF (Refs ippoan/alc-app#238 / ippoan/alc-app-s3#135)。
 *
 * 血圧計 (ニプロ NBP-1BLE) の受信・送信ロジックは残したまま、画面表示だけを
 * このフラグで隠す。将来オプションとして表示単位を選べるようにする計画だが、
 * 単位 (テナント単位か端末単位か等) は未確定のため、今は定数 1 つで一律に隠す。
 */
export const SHOW_BLOOD_PRESSURE = false

/**
 * 体温だけの運用 (SHOW_BLOOD_PRESSURE=false) で、CoreS3 から体温が届いてから
 * 自動で次のステップへ進むまでの待ち時間 (ms)。値を確認できる程度に見せてから進む
 * (Refs #238)。
 */
export const MEDICAL_AUTO_NEXT_DELAY_MS = 1500
