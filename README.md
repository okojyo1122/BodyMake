# 自宅トレーニング・フォームガイド

## GitHub Pagesで公開する手順
1. GitHubで新しいリポジトリを作成（例：`training-guide`）。
2. このフォルダ内の `index.html` をリポジトリ直下にアップロード。
3. リポジトリの **Settings → Pages** を開く。
4. **Build and deployment** の Source を **Deploy from a branch** にする。
5. Branch を `main`、Folder を `/ (root)` にして Save。
6. 公開完了後、`https://<GitHubユーザー名>.github.io/training-guide/` の形式のURLを確認する。
7. そのURLをChatGPTに送ると、QRコード入りの最終版トレーニング記録PDFを作成できます。

※ リポジトリ名を `training-guide` 以外にした場合はURL末尾も変更されます。
※ GitHub Pagesの公開設定や反映には数分かかる場合があります。

## 週間献立・買い物リスト（`meals/`）

夫婦2人分の週間献立・買い物リスト・予算管理ページです。公開URL：`https://okojyo1122.github.io/BodyMake/meals/`

- 画面：`meals/index.html`・`meals/app.js`・`meals/meals.css`
- 計算ロジック（集計・予算・栄養・アレルギー検証）：`meals/lib/plan-core.js`（ブラウザとNodeで共用）
- データ：`data/meals/`（仕様は [data/meals/README.md](data/meals/README.md)）
- 購入済み・在庫あり・個別設定は、ブラウザのLocalStorageに保存します（端末ごと）

### 手元での確認（Node.js 20以上、追加インストール不要）

```
npm test            # テスト
npm run validate    # 献立データの検証
npm run serve       # http://127.0.0.1:8080/BodyMake/ で確認
```

※ 価格は東京都内の一般的なスーパーを想定した推定（概算）、栄養値は目安です。
※ APIキーなどの秘密情報をHTML・JavaScript・JSONに置かないでください（公開サイトです）。
