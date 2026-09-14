# 店舗アプリの追加機能

## ブランド図鑑

- 下部タブ・接続設定の「ブランド図鑑」または `brand-guide.html` から利用。旧 `#brand-guide` は専用ページへ案内。
- 図鑑専用ページは在庫API・認証・同期コードを読み込まない。外部通信・画像の外部読み込みはCSPでも禁止。
- 画面: `brand-guide.js` / `brand-guide.css`。既存のhashルーターへ登録。
- 調査資料は公開しない。別途受け取った専用JSONファイルを端末内に保存する。
- データ形式: `format=private-brand-guide`, `schemaVersion=1`, `payload`（JSON文字列）, `sha256`（payloadのUTF-8 SHA-256）。payloadは30ブランド、タグ年表、画像、平易な型番説明、出典、ベイクルーズ付録を含む。
- 画像は確認済みのJPEGをdata URLとして同梱。再調査・画像の描き直しはしない。
- 保存は図鑑専用IndexedDB。取り込み失敗時に以前の資料を消さない。アプリの在庫・認証DBと分離。
- 更新手順: 既存資料から新しい私用ファイルを作成 → 内容照合 → アプリで取り込む。資料をGitへ追加しない。
- テスト: `node --test route-brand-guide.test.mjs` と既存全テスト、`node verify-pwa-version.mjs`。
