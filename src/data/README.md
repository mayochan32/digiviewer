# 日本語種名データ

和名はアプリに同梱し、判定結果の表示時に読み込みます。利用者のPCから名前の取得に通信せず、モデルの再導入や追加の実行環境は不要です。出典ボタンを押したときだけブラウザで出典を開きます。

## 元の辞書

`japanese-species-names.json` はv0.6.1で導入したWikidata（CC0-1.0）の12,580学名です。2026-09-22の取得内容を保持しています。種階級（P105 = Q7432）、学名（P225）、日本語ラベル、日本語Wikipedia記事がある項目を抽出したもので、日本の全種を数えたものではありません。

- 出典・利用条件: [Wikidata](https://www.wikidata.org/)、[Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)、[CC0](https://creativecommons.org/publicdomain/zero/1.0/)
- 元の取得処理: `scripts/update-japanese-species-names.py`。元の辞書の再現用です。通常の拡張は次の手順で行います。

## 追加辞書

`japanese-species-names-supplement.json` は元の辞書にない学名だけを収録します。各値は `[和名, 出典ID, 出典内の識別子]` です。収録数・取得日・元辞書と入力資料のSHA-256・出典と利用条件を保存します。

- `wikidata`: 日本のGBIF生息記録があるBioCLIP 2候補を優先してWikidataを照会。日本語Wikipedia記事の条件を外しています。種階級の学名と日本語ラベルだけを使い、識別子はWikidataのQ番号です。世界全体の日本語ラベルを網羅する取得ではありません。全体検索は公開サーバーの時間制限を超えるため、150学名ずつの照会に分けます。
- `nilim-r07`: 国土技術政策総合研究所「河川水辺の国勢調査のための生物リスト（令和7年度）」をDigiViewerが加工して作成。出典は[国土技術政策総合研究所の生物リスト掲載ページ](https://www.nilim.go.jp/lab/fbg/ksnkankyo/mizukokuweb/system/seibutsuListfile.htm)、利用条件は[公共データ利用規約（PDL1.0）](https://www.nilim.go.jp/aboutlink.htm)。2026-10-12に取得した全生物種ファイルの「目録リスト」の学名と種和名を使用し、識別子は種コードです。魚類・底生動物・植物・鳥類・両爬哺・陸上昆虫類等が対象です。別途令和8年度版が公開されているプランクトン専用行は取り込みません。

追加分は二名法の学名とカタカナの和名に限定します。属・亜種・不明種・ラテン文字だけの和名欄・著者付き学名は採用せず、属名や亜種名から種の和名を推測しません。新規の学名に異なる和名がある場合は除外し、既存名と異なる場合は従来の名前を維持して監査ファイルに記録します。複数出典の和名が一致する場合は国内リストの出典を優先します。標準和名の保証や、全種の網羅を意味しません。

`japanese-species-aliases.json` は確認済みの旧学名・表記差の対応です。出典URLを各対応に記録し、文字の類似から対応させません。

## 再生成

開発者の隔離したPython環境に `openpyxl` を用意します（今回の読み取りは3.1.5）。この依存はDigiViewerや利用者用Pythonには追加しません。

1. 掲載ページから令和7年度「全生物種」の `R07zenseibutsu.xlsx` を取得します。
2. 導入済みBioCLIP 2の `txt_emb_species.json` と、完全取得済みの `japan-names.json` を用意します。個人の写真は使用しません。
3. 新しい一時ディレクトリをキャッシュに指定して実行します。

```sh
python3 scripts/expand-japanese-species-names.py \
  --nilim-input /path/to/R07zenseibutsu.xlsx \
  --cache /path/to/fresh-query-cache \
  --model-labels /path/to/txt_emb_species.json \
  --japan-names /path/to/japan-names.json \
  --retrieved YYYY-MM-DD
```

取得途中で失敗したら同じキャッシュで再開できます。別の日の取得には新しいキャッシュを使い、取得日を正しく記録してください。全照会が完了し、JSON・列構造・件数の確認が済むまで同梱辞書を書き換えません。取得対象範囲と検索式を含む完全なJSONを保存してある場合は、`--cache` の代わりに `--wikidata-input` を指定できます。

結果は追加辞書と `docs/japanese-names-expansion-audit.json` に出力します。後者には競合と表示率を記録します。モデル照合の表示率は画像判定の正解率ではありません。計測の条件・結果は `docs/japanese-names-expansion-0.6.2.md` を参照してください。

## 確認

- `node --test tests/project.test.mjs tests/species-names.test.mjs`
- `python3 -B -m unittest discover -s tests -p 'test_japanese_names_builder.py'`
- `npm run build`
- UI操作: Viteを起動し、Playwrightが利用できる開発環境で `node scripts/test-species-ui.mjs`。必要に応じて `DIGIVIEWER_PLAYWRIGHT_PACKAGE`、`DIGIVIEWER_TEST_BROWSER_CHANNEL=chrome`、`DIGIVIEWER_TEST_SCREENSHOT` を指定します。

UIテストは報告されたチョウ・テントウムシの候補を固定応答として使用します。実際の表示コンポーネントで和名、出典、スコアの維持、入力反映、改名の成否を確認し、画像認識精度を測るテストとは区別します。

## 昆虫の追加辞書（Catalogue of Life）

`japanese-insect-names.json` は前段階の辞書で和名が出なかった、日本の記録があるモデル候補の昆虫5,809学名を対象にした追加分です。GBIFが使うCatalogue of Lifeの固定版 **2026-08-26 XR / ChecklistBank 316165** を照合し、元の辞書・既存の旧学名対応は変更しません。

出典: Bánki et al. (2026), *Catalogue of Life* (2026-08-26 XR), Catalogue of Life Foundation。[データセット・引用情報](https://doi.org/10.48580/dgyy9)、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。DigiViewerが抽出・加工しており、原典がDigiViewerや判定結果を推奨するという意味ではありません。

採用条件:

- 完全一致検索の全応答を確認し、同じ学名が複数の項目に該当する場合は除外。動物界・昆虫綱・モデルと同じ科であること、種階級、分類上の状態を確認します。
- 種階級の日本語・カタカナ名だけを採用します。亜種の和名を種の和名に切り詰めません。種階級が明示された `Genus (Subgenus) species` の亜属表記は、同じ分類IDに対応することを確認して扱います。
- 異名は出典に明記された受容種IDをたどります。既存辞書から別の学名の和名を使う場合は、受容種名または明記された同タイプ異名（homotypic synonym）との対応に限定します。新たに追加した項目を再帰的につなげません。
- 受容種・同タイプ異名・既存辞書の和名が競合した場合、分類上の問題が未解決の場合、既に前段階で競合とした場合は追加しません。出典の `homotypic consolidation`（解決済みの統合）だけは許可し、`homotypic consolidation unresolved` など他の問題フラグは除外します。

各項目に和名の出典URL、必要に応じて学名対応の出典URLを保持します。画面の「学名の対応の出典」から異名の根拠を開けます。監査ファイル `docs/japanese-insect-names-audit.json` に採用根拠・不採用理由・取得した応答のSHA-256・同じ分母での表示率を記録します。カタカナ表記や出典の網羅性には限界があり、すべての標準和名の収録を保証するものではありません。

開発者向け再生成（Python標準ライブラリのみ）:

```sh
python3 scripts/expand-japanese-insect-names.py \
  --cache /path/to/col-response-cache --fetch \
  --retrieved YYYY-MM-DD \
  --model-labels /path/to/txt_emb_species.json \
  --japan-names /path/to/japan-names.json
```

前段階の辞書を作成してから実行します。固定版の完全一致検索と種の詳細を最大6並列で取得し、失敗時は再試行します。途中失敗時は同じキャッシュで再開できます。`--fetch` を外すと通信せずに再生成し、必要な応答が欠けていれば中断します。別日に取得する場合は新しいキャッシュを指定してください。取得・照合が完了するまで同梱辞書を書き換えません。利用者のアプリはこの処理を実行せず、同梱JSONを読むだけです。

検証: `python3 -B -m unittest discover -s tests -p 'test_japanese_insect_builder.py'`。既存のNodeテストとUIテストにも、キイロテントウなどの追加和名・異名リンク・従来名を維持する検証を含めています。
