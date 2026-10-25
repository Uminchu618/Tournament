# トーナメント表

Cloudflare Workers・D1・Accessで動く大会運営アプリです。招待された運営者が大会内に最大16部門を作成し、各部門の2〜64組を名簿順で配置します。団体名・氏名、任意の第1〜第4シード、手動の枠調整に対応し、勝者・得点・試合日時・会場・注記を記録します。複数大会を保存し、下書き保存と公開を別々に行います。

大会を一般向け一覧に掲載せず、大会ごとのURLで共有します。公開画面は5分ごとに更新を確認し、手動でも更新できます。A4縦の画面表示と、日本語フォントを埋め込んだPDFの直接ダウンロードに対応しています。

## 利用先と文書

- [本番の運営者画面](https://tournament-board-production.uminchu.workers.dev/admin)
- [検証環境の運営者画面](https://tournament-board-staging.uminchu.workers.dev/admin)
- [要求分析](要求分析.md)：質問・回答と受入条件。
- [Cloudflare構成設計書](Cloudflare構成設計書.md)：DB、認証、保存・公開、APIと運用。
- [システム設計書](トーナメント表システム設計書.md)：BYE、描画と印刷。
- [テスト結果](テスト結果.md)：実施した検証と残る確認事項。

運営者画面では、許可されたメールアドレスに届くワンタイムコードでログインします。公開画面のURLは大会の編集画面から取得してください。

## ローカル開発

Node.js 24以上が必要です。

```sh
npm ci
npm run db:local
npm start
```

`http://127.0.0.1:8787/admin`を開きます。ローカルのループバック接続に限り、開発用運営者`dev@localhost`を使います。配置したWorkersではこの開発用認証は使えません。

ローカルD1は`.wrangler/`に保存され、本番DBとは別です。公開用ファイルだけを`dist/public/`へ生成するため、`.env`、設計書、Workerのソース、バックアップは静的配信の対象に含みません。

## Cloudflareへの配置

`.env.example`を参考に、`.env`へ`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を設定します。`.env`はGitへ登録しません。Wranglerの実行にはこれらを渡し、ローカルWorkerのアプリ用変数には自動で取り込まない設定です。

初回はCloudflareのZero Trustを有効にし、Freeプランの初期設定を完了してください。以後の構成準備は次のコマンドで行えます。

```sh
npm run cf:setup -- staging 管理者のメールアドレス
npm run wrangler -- d1 migrations apply tournament-board-staging --config wrangler.staging.json --remote
npm run cf:operator -- staging add 管理者のメールアドレス admin
node scripts/seed-service.mjs
npm run build
npm run wrangler -- deploy --config wrangler.staging.json
```

本番では`staging`を`production`に置き換えます。`seed-service.mjs`は検証専用であり、本番では実行しません。検証用のサービス認証は本番に設定せず、本番にはテスト大会を入れません。

`wrangler.staging.json`と`wrangler.production.json`には、配置先DBとAccessの識別子を保持します。これらは秘密鍵ではありません。APIトークンやサービス認証のClient Secretを構成ファイルへ書かないでください。

## 操作

1. 運営者画面で大会を作成し、大会情報と部門名・種別を入力します。複数の部門を追加できます。
2. 「1 名簿」で「団体名 氏名」を1行ずつ貼り付け、「追加して組合せを作成」を押します。「2 組合せ」で配置進捗と未配置者を確認し、必要なら入れ替えます。シードと不戦勝の配置も自動で行います。
3. 部門を選び、「3 試合結果」で試合ごとの最終得点、勝者、開始日時、会場、注記を入力します。得点から勝者は自動判定しません。
4. 「下書きを保存」で保存し、「公開する」で保存版を共有URLへ反映します。
5. 部門を選んで「PDFをダウンロード」を押します。紙への出力はダウンロードしたPDFから行います。

保存と公開は大会内の全部門が対象です。公開には全部門の組合せ完成が必要です。団体戦はチーム単位とし、先鋒〜大将の5人の登録・勝敗集計は今後の対応です。旧形式の保存済み大会は「部門1」として開けます。

組合せや勝者の変更では、影響する結果・得点などの取消を確認します。同じ大会を別画面から保存して競合した場合は、未保存の入力を残して保存を拒否します。「保存版を再読込」は、確認後に未保存の変更を破棄します。

スマートフォンでは「編集」と「表を見る」を切り替えます。拡大表示は画面上だけに適用し、印刷・PDFのA4サイズは変えません。試合情報が多い場合は、表の後ろに試合情報のページを追加します。

## 検証

```sh
npm test
npx playwright install chromium
npm run db:local
npm run test:e2e
```

Cloudflare上の総合テストは検証環境だけで実行します。`cf:setup`が作る`.artifacts/access-staging.json`を使い、Accessのサービス認証で操作します。メールコードの配送・入力そのものを代行するテストではありません。

```sh
E2E_BASE_URL=https://tournament-board-staging.uminchu.workers.dev npm run test:e2e
node scripts/load-test.mjs
```

テスト結果、スクリーンショット、PDFは`.artifacts/`に出力します。秘密情報やテストデータが含まれる可能性があるため、このディレクトリ全体を公開・コミットしません。

## 運営者とバックアップ

運営者は`npm run cf:operator -- production list`、`add メールアドレス admin|editor`、`disable メールアドレス`で管理します。Access側の許可メールにも同じ変更を反映してください。最後の有効な管理者の停止・権限引下げは拒否します。

```sh
node scripts/backup.mjs production
node scripts/restore-check.mjs
```

DBをエクスポートし、圧縮とAES-256-GCMによる暗号化・復号検証を行います。復元確認は一時的なローカルD1で実施し、リモートDBへ書き戻しません。エクスポート時には短時間DBを使えなくなる場合があるため、大会の進行中を避けて実行します。

暗号鍵は`BACKUP_ENCRYPTION_KEY`に32バイトのBase64を設定します。未設定のローカル実行では`.artifacts/backup-key`へ生成し、CIでは未設定をエラーにします。復旧に必要な鍵を、バックアップ本体と別に保管してください。

バックアップの実行先は手元のPCとし、利用者の希望により定期実行の設定は後で行います。当面は上記コマンドで手動実行してください。GitHubへのSecrets登録やワークフローの有効化は行っていません。Cloudflare側のCronは古い中間版・操作記録の整理を担当し、バックアップは行いません。

バックアップの成功日時を確認し、保存したデータと暗号鍵を別々に保管してください。定期実行を有効にするまでは、バックアップ間隔を手動で管理します。独自ドメインの購入・設定、有料プランへの変更は別途扱います。
