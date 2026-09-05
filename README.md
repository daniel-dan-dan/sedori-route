# 店舗巡回ルートPWA

店舗選択、選択順ルート、Google Mapsナビ、仕入れ記録、巡回履歴、分析をスマートフォンで扱うPWAです。

## 安全設計

- GAS接続コードと端末専用鍵は専用IndexedDBへ保存し、localStorageや画面へ露出しません。
- CSPで同一配信元以外のスクリプトとinline scriptを遮断します。
- 外部データを地図ポップアップへHTML文字列として挿入しません。
- 書込前にoperation IDと本文をIndexedDBへ保存します。同じ在庫・内容の未確定受付があれば、新しいIDで送信しません。
- サーバーは書込開始前に受付を保存し、応答記録に失敗した受付を二重実行しません。結果不明、7日超、12回失敗した項目は自動再送を停止します。結果不明は受付IDから個別に照合してください。
- 店舗の候補が1件でも自動書戻しせず、選択後に在庫UUID・変更前の店名・仕入日を比較します。在庫の読み込み失敗時は優先度を空集計で上書きしません。
- 距離と時間は直線距離による概算です。1店舗でも滞在時間を含み、0分も有効です。道路・混雑・営業時間は未反映です。
- v196の新規在庫登録経路（addInventoryPurchase）は既存方式のままです。正本側の専用受付への統合は追加承認待ちで、完了扱いにしません。

## 確認

```bash
node --test *.test.mjs
node verify-pwa-version.mjs
```

公開前後の画面確認は [MOBILE_RELEASE_CHECKLIST.md](MOBILE_RELEASE_CHECKLIST.md) に従います。

## 公開

`main` へのpushでGitHub Pagesへ反映されます。CSS/JavaScript/Service Workerを変えた場合は、`CACHE_NAME`、全cache bust、画面版数、`ASSET_VER`を同じ版へ更新します。
