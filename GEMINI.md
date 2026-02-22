# Project Constitution (GEMINI.md)

- Output language: Japanese
- Stack: Discord.js + CDP (Node.js)
- Prefer small, safe diffs.
- Never invent API responses; ask when unsure.
- Follow project Rules and existing patterns.
- githubの操作はghを使用して

## Development Rules
- **Scheduling**: 全ての定時実行タスク（スケジューラー）は、`workspace/schedules.json` に登録すること。コードへのハードコーディングは禁止。
- **Management**: スケジュールの管理（追加・削除・一覧）は Discord の `/schedule` コマンドを通じて行うこと。
- **Environment**: win32環境（PowerShell）では、コマンド連結の '&&' を絶対に使用せず、gitコマンド等は必ず1行ずつ個別に実行すること。
- **Branching**: プロジェクトの main ブランチには直接プッシュせず、軽微な修正でも必ず作業ブランチを作成し 'gh pr create' を通じて統合すること。
- **Verification**: 複数のプルリクエストをマージする際は、一括マージ後の修正ではなく、1つマージするごとに検証（tscチェック等）を行うこと。
