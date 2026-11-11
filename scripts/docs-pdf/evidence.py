"""様式3-1・3-2 の資料番号ごとの根拠資料 (様式1 の添付 5) を HTML に組む。

使い方: python evidence.py <mkdocs が build した site/> <HTML の出力先>

- 見出しの ID は、同じ CI で build した site/ の HTML から読む (公開中のページは見ない)
- 様式 (docx) と製品の自己点検の回答は ippoan/tenko-forms から raw で取る
- 参照先の見出しが 1 つでも見つからなければ exit 1 で止める
"""
import html
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

BASE = "https://ippoan.github.io/alc-app/"
FORMS_RAW = "https://raw.githubusercontent.com/ippoan/tenko-forms/main/"

# site/ 内のページ: (URL のパス, ガイド名)。運行管理者ガイドは個別ページを先に探す
PAGES = [
    ("operator/", "運行者ガイド"),
    ("admin/health-baseline/", "運行管理者ガイド"),
    ("admin/tenko-schedule/", "運行管理者ガイド"),
    ("admin/tenko-record/", "運行管理者ガイド"),
    ("admin/equipment-failure/", "運行管理者ガイド"),
    ("admin/webhook/", "運行管理者ガイド"),
    ("admin/", "運行管理者ガイド"),
    ("admin/sysadmin/", "システム管理者ガイド"),
    ("support/", "サポート"),
]

FORMS = [
    ("nintei-yoshiki3-1-gyomumae-check", "pre",
     "業務前自動点呼機器の要件に係る根拠資料 (様式３－１ 資料番号①〜㉗)"),
    ("nintei-yoshiki3-2-gyomugo-check", "post",
     "業務後自動点呼機器の要件に係る根拠資料 (様式３－２ 資料番号①〜⑲)"),
]


def fetch(path):
    with urllib.request.urlopen(FORMS_RAW + path, timeout=60) as r:
        return r.read()


def headings(page_html):
    out, stack = [], []
    for lvl, hid, t in re.findall(r'<h([1-4]) id="([^"]+)"[^>]*>(.*?)</h\1>', page_html, re.S):
        lvl = int(lvl)
        t = html.unescape(re.sub("<[^>]+>", "", t)).replace("¶", "").strip()
        stack = [x for x in stack if x[0] < lvl] + [(lvl, t)]
        out.append((hid, t, [x[1] for x in stack]))
    return out


def resolve(head, guide, comps):
    """ガイド名と見出しの経路 → (表示名, URL)"""
    last = comps[-1]
    for path, g in PAGES:
        if g != guide:
            continue
        for hid, t, anc in head[path]:
            if t == last and all(c in anc for c in comps[:-1]):
                url = BASE + path + ("" if anc == [t] else "#" + hid)
                return f"{guide} > {' > '.join(comps)}", url
    return None


def refs(head, evidence):
    if "「" not in evidence:  # (ア) マニュアル全体
        return [("運行者ガイド", BASE + "operator/"), ("運行管理者ガイド", BASE + "admin/"),
                ("システム管理者ガイド", BASE + "admin/sysadmin/")], []
    out, missing, guide = [], [], None
    for q in re.findall(r"「([^」]+)」", evidence):
        parts = [p.strip() for p in q.split(">")]
        if parts[0].endswith("ガイド") or parts[0] == "サポート":
            guide, comps = parts[0], parts[1:]
        else:
            comps = parts
        r = resolve(head, guide, comps) if guide else None
        (out.append(r) if r else missing.append(q))
    return out, missing


def rows(docx):
    x = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode()
    for tr in re.findall(r"<w:tr[ >].*?</w:tr>", x, re.S):
        cells = []
        for tc in re.findall(r"<w:tc>.*?</w:tc>", tr, re.S):
            ps = re.findall(r"<w:p[ >].*?</w:p>", tc, re.S)
            cells.append("\n".join("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p)) for p in ps).strip())
        if len(cells) == 5 and cells[4].startswith("資料番号"):
            yield cells


def key(label):
    m = re.match(r"^（(.)）", label)
    return m.group(1) if m else label


def build(head, product, docx, kind, title):
    answers = product["self_check"][kind]
    blocks, missing_all = [], []
    for item, req, _, _, ev in rows(docx):
        num = ev.split("\n")[0].replace("資料番号", "").strip()
        a = answers.get(key(item), {})
        links, missing = refs(head, a.get("evidence", ""))
        missing_all += [(num, m) for m in missing]
        notes = "\n".join(ev.split("\n")[1:])
        link_html = "".join(
            f'<li>{html.escape(n)}<br><a href="{u}">{html.escape(u)}</a></li>' for n, u in links
        ) or "<li>(参照先なし)</li>"
        blocks.append(f"""
<section class="item">
  <div class="num">資料番号{html.escape(num)}</div>
  <div class="key">項目 {html.escape(item.splitlines()[0])}</div>
  <h3>要件</h3><p class="req">{html.escape(req).replace(chr(10), '<br>')}</p>
  <h3>適否</h3><p>{html.escape(a.get('ok') or '')}</p>
  <h3>機能・体制の内容</h3><p>{html.escape(a.get('detail') or '')}</p>
  <h3>根拠 (操作マニュアル)</h3><ul>{link_html}</ul>
  {f'<p class="note">{html.escape(notes)}</p>' if notes else ''}
</section>""")
    name = f"{product['product']} {product['version']}"
    doc = f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>{title}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
<style>
@page {{ size: A4 portrait; margin: 15mm 16mm; }}
body {{ font-family: 'Noto Sans JP', 'Noto Sans CJK JP', sans-serif; font-size: 9.5pt; line-height: 1.6; color: #1f2933; margin: 0; }}
.cover {{ page-break-after: always; padding-top: 60mm; }}
.cover h1 {{ font-size: 20pt; margin: 0 0 4mm; }}
.cover p {{ margin: 1mm 0; }}
.item {{ border: 1px solid #bcccdc; border-radius: 2mm; padding: 3.5mm 5mm; margin: 0 0 5mm; page-break-inside: avoid; }}
.num {{ font-size: 13pt; font-weight: 700; color: #1e5f74; }}
.key {{ color: #52606d; margin-bottom: 1mm; }}
h3 {{ font-size: 9pt; color: #52606d; margin: 2mm 0 .5mm; }}
p {{ margin: 0; }}
.req {{ background: #f0f4f8; padding: 1.5mm 2.5mm; border-radius: 1mm; }}
ul {{ margin: 0; padding-left: 5mm; }}
a {{ color: #1e5f74; word-break: break-all; }}
.note {{ font-size: 8.5pt; color: #52606d; margin-top: 1.5mm; }}
</style></head><body>
<section class="cover">
  <h1>{title}</h1>
  <p>機器の名称: {html.escape(name)}</p>
  <p>製作事業者: 合同会社一歩庵</p>
  <p>操作マニュアル (取扱説明書): <a href="{BASE}">{BASE}</a></p>
  <p style="margin-top:6mm">各資料番号の「根拠 (操作マニュアル)」は、公開している操作マニュアルの該当箇所です。</p>
</section>
{''.join(blocks)}
</body></html>"""
    return doc, len(blocks), missing_all


def main():
    site, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    head = {p: headings((site / p / "index.html").read_text(encoding="utf-8")) for p, _ in PAGES}
    manifest = json.loads(fetch("manifest.json"))
    product = json.loads(fetch("product/ippoan-tenko.json"))
    failed = False
    for form, kind, title in FORMS:
        docx = fetch(manifest["forms"][form]["latest"])
        doc, n, missing = build(head, product, docx, kind, title)
        (out_dir / f"evidence-{kind}.html").write_text(doc, encoding="utf-8")
        print(f"evidence-{kind}: {n} 項目, 見つからない参照先 {len(missing)} 件")
        for num, q in missing:
            print(f"  資料番号{num}: 「{q}」", file=sys.stderr)
        failed |= n == 0 or bool(missing)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
