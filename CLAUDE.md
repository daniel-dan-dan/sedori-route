# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## アプリ概要

店舗せどり向けPWA。店舗選択 → ルート最適化 → Google Mapsナビ → 仕入れ記録 → 分析。
GitHub Pages (`daniel-dan-dan/sedori-route` → `https://daniel-dan-dan.github.io/sedori-route/`) で配信。

## アーキテクチャ

```
[スマホ PWA] ←→ [GAS Web API] ←→ [Google スプレッドシート]
```

バックエンドのGASコードとスプレッドシートはこのリポジトリ外（`~/店舗巡回ルート最適化/gas/Code.gs`）。

### PWA内部構造（すべて素のJS、ビルドなし。`<script>`で順に読み込み）

- `storage.js` — IndexedDB（`sedori-route` DB）でstores/config/currentRoute/pendingActionsをキャッシュ＆同期キュー。`online`イベントで自動flush。
- `api.js` — GAS `doGet`/`doPost` へのfetchラッパー。URLは `localStorage['gas_api_url']` から取得。オフライン時はPOSTを`Storage.addPendingAction`へキュー。
- `route-optimizer.js` — Haversine距離 → 最近傍法 → 2-opt改善のクライアントサイドTSP。Google Maps ナビURL生成もここ。`calcSelectionOrder`は選択順そのままの距離計算。
- `router.js` — hashベースSPAルーター（`#home`, `#patrol`, `#history`等）。
- `app.js` — 全ビュー描画とイベント処理を一枚岩モジュールで実装。**95KB超・重要定数はトップに集約**:
  - `CHAIN_COLORS` / `CHAIN_LOGOS` — 27チェーンのブランドカラーとロゴ画像パス（`icons/chains/*.png`）
  - `AREAS` — 座標ベースのエリア自動分類（仙台中心に同心円で分割）。`test`は排他的に上から判定。
  - `CHAIN_RULES` — 店舗名regex→チェーン名のマッピング。**長い名前を先に判定**（例: `BOOKOFF SUPER BAZAAR` → `ブックオフSB` を `ブックオフ`より先）。
- `sw.js` — Service Worker、ネットワーク優先・キャッシュフォールバック。`script.google.com` はキャッシュ除外。**ロゴ/CSS/JSを変更したら必ず `CACHE_NAME` のバージョン番号をバンプ**（例: `sedori-route-v32` → `v33`）。

### ロゴ管理

`icons/chains/*.png` は全て128x128透過PNGに正規化済み。原本は `/tmp/logos/`（リポジトリ外）。ユーザーの方針: **ロゴマーク+アルファベット店名の構成はマーク部分のみ使用**（ケーズデンキの`K's`マーク風）。

## GAS API contract

`api.js` が呼ぶアクション（GET/POSTで分かれる）:

- **GET**: `getStores`, `getConfig`, `getRouteHistory`, `getPurchases`, `getMemos`, `getFinds`, `getPurchaseItems`
- **POST**: `addStore`, `updateStore`, `deleteStore`, `startRoute`, `updateStop`, `endRoute`, `addStopToRoute`, `addPurchase`, `addPurchaseItems`, `updateConfig`, `deleteRoute`, `clearHistory`

POSTは `Content-Type: text/plain` + JSON body（GASのCORSプリフライト回避）。レスポンスがJSONでない場合も書き込み自体は成功していることが多く `{ _rawResponse: true }` を返す。

## デプロイ

```bash
# PWA配下でcommit → pushだけでGitHub Pagesが即反映（別CI/CDなし）
git add <files> && git commit -m "..." && git push
```

変更が反映されないときは：
1. `sw.js` の `CACHE_NAME` バージョンがバンプされているか確認
2. スマホ/ブラウザでPWA強制再読み込み（キャッシュ除去 or タスクキルで再起動）

## 開発

ビルドツールなし・テストなし。ブラウザでローカル確認するときは:

```bash
python3 -m http.server 8000
# → http://localhost:8000/
```

初回アクセス時、設定画面でGAS Web App URL を入力する必要あり（`localStorage['gas_api_url']`）。

## 注意

- `app.js` は単一ファイルでモジュール分割していない。新機能も既存パターン（関数 + Router.register）を踏襲する。
- 住所・座標の修正では GSI (国土地理院) APIは**住所のみ**対応。店舗名検索は不可なので、POI検索は別途手動かWikipedia Commons経由で。
- 選択順番号は `CIRCLED_NUMBERS` で ① 〜 ⑳ を使い、21件目以降は `(21)` 表記にフォールバック。
