---
name: next-session
description: 次セッションへの引き継ぎを作成。plan ファイルの進捗更新 + .claude/handoff.md に次にやることを保存。CCoW では引き継ぎ用 issue にもコメントし、その permalink をユーザーに提示する。
---

# 次セッションへの引き継ぎを作成

## やること

1. **plan/implementation-plan.md の進捗を更新**: 完了したタスクに `[x]` を付け、Phase 見出しに ✅ (完了) / 🔧 (進行中) を追記する
2. **git 状態を確認**: `git status` で未コミットの変更を把握する
3. **`.claude/handoff.md` に次にやることだけを書く**:

```markdown
## 未コミットの変更
- (あれば git status の結果を簡潔に)

## 次にやること
- 最優先タスク
- その次のタスク
- ...

## 注意点
- 次のセッションで知っておくべき制約や決定事項のみ (最小限)
```

4. **CCoW (Claude Code on the Web) セッションの場合は引き継ぎ用 issue にも残す**:
   コンテナは ephemeral で次セッションは fresh clone から始まるため、handoff.md だけだと
   commit/push 前に消える。GitHub 側に正本を置き、リンクで次セッションへ渡せるようにする。
   - **引き継ぎ先 issue を決める** (1 本に集約して乱立を防ぐ):
     - `$ARGUMENTS` に issue 番号 / URL があればそれを使う
     - 無ければ `handoff` ラベルの open issue を探して再利用する
     - それも無ければ新規作成する (title: `🔁 Session handoff`, label: `handoff`)
   - **GitHub MCP の issue コメント tool** (例: `mcp__github__add_issue_comment`) で
     handoff.md と同じ 3 セクションを投稿する。先頭に「日付・どのブランチからの引き継ぎか」を
     1 行入れる
   - push 済みブランチ名、関連 PR / commit のリンクを本文に含める
   - **`Refs #N` を使う** (`Closes` / `Fixes` / `Resolves #N` は禁止 — auto-close 防止)
   - **秘密の値 (token / API key / password) を本文に書かない** — 名前だけ書き、
     値は `secret-inject` 経由。会話・log・issue に値が出た時点で compromised
5. **handoff.md を commit & push**: ローカル経路で `git add .claude/handoff.md` →
   commit → `git push -u origin <branch>`。`create_or_update_file` / `push_files` は使わない
6. **ユーザーに報告**: 保存完了に加え、投稿した **issue コメントの permalink を提示**する。
   次セッションでは `/resume-session <permalink>` にそのまま渡せる旨を添える

## ルール
- **要約は不要** — 過去にやったことは plan ファイルに記録済み
- **次にやることにフォーカス** — 次のセッションの Claude がすぐ着手できるように
- 簡潔に。長い文書は書かない
- CCoW 以外 (ローカル CLI) では issue コメントは任意。handoff.md + commit で足りるなら skip 可
  (ローカルは `claude --teleport` / web の follow-up で会話ごと継続できるため)
- $ARGUMENTS があればそれを「次にやること」の先頭に含める
