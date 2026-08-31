# 店舗巡回ルートPWA

店舗選択、選択順ルート、Google Mapsナビ、仕入れ記録、巡回履歴、分析をスマートフォンで扱うPWAです。

## 安全設計

- GAS接続コードと端末専用鍵は専用IndexedDBへ保存し、localStorageや画面へ露出しません。
- CSPで同一配信元以外のスクリプトとinline scriptを遮断します。
- 外部データを地図ポップアップへHTML文字列として挿入しません。
- オフライン書込にはoperation IDを付け、7日超または12回失敗した項目は自動再送を停止します。

## 確認

```bash
node --test route-app.test.mjs
node verify-pwa-version.mjs
```

公開前後の画面確認は [MOBILE_RELEASE_CHECKLIST.md](MOBILE_RELEASE_CHECKLIST.md) に従います。

## 公開

`main` へのpushでGitHub Pagesへ反映されます。CSS/JavaScript/Service Workerを変えた場合は、`CACHE_NAME`、全cache bust、画面版数、`ASSET_VER`を同じ版へ更新します。
