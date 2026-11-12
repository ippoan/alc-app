#!/usr/bin/env bash
# mkdocs が build した site/ に、認定申請の資料の PDF を site/downloads/ として足す。
# 使い方: scripts/docs-pdf/build.sh [site のパス (既定 site)]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="$(cd "${1:-site}" && pwd)"
CHROME="${CHROME:-google-chrome}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$SITE/downloads"
mkdir -p "$OUT"

pdf() { # pdf <入力 HTML> <出力 PDF>
  "$CHROME" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer \
    --run-all-compositor-stages-before-draw --virtual-time-budget=20000 \
    --user-data-dir="$WORK/profile" \
    --print-to-pdf="$2" "file://$1" 2>/dev/null
  [ -s "$2" ] || { echo "PDF ができなかった: $2" >&2; exit 1; }
  echo "$(basename "$2"): $(pdfinfo "$2" 2>/dev/null | awk '/^Pages:/{print $2}') ページ"
}

python3 "$HERE/evidence.py" "$SITE" "$WORK"

# 印刷用ページに目次を組むスクリプトを差し込んだ写しを、同じフォルダに置いて PDF にする
MANUAL="$SITE/print_page/.pdf.html"
python3 - "$SITE/print_page/index.html" "$HERE/print-toc.js" "$MANUAL" <<'PY'
import sys
page, js, out = sys.argv[1:]
s = open(page, encoding="utf-8").read()
assert "</body>" in s
s = s.replace("</body>", "<script>" + open(js, encoding="utf-8").read() + "</script></body>", 1)
open(out, "w", encoding="utf-8").write(s)
PY
pdf "$MANUAL" "$OUT/manual.pdf"
rm -f "$MANUAL"
pdf "$WORK/evidence-pre.html" "$OUT/evidence-pre.pdf"
pdf "$WORK/evidence-post.html" "$OUT/evidence-post.pdf"
pdf "$HERE/company-profile.html" "$OUT/company-profile.pdf"
pdf "$HERE/brochure.html" "$OUT/brochure.pdf"
