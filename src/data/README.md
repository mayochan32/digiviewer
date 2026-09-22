# 日本語種名データ

`japanese-species-names.json` はWikidataの構造化データ（CC0-1.0）から作成した同梱辞書です。取得日・検索式・収録数・各項目のWikidata IDをファイル内に記録しています。

- 出典: https://www.wikidata.org/
- ライセンス: https://www.wikidata.org/wiki/Wikidata:Licensing
- CC0: https://creativecommons.org/publicdomain/zero/1.0/
- 種階級（P105 = Q7432）で、日本語Wikipediaへのリンクと日本語ラベルがある項目の学名（P225）を対象とします。
- 二名法に完全一致する学名、日本語のカタカナを含むラベルだけを収録します。属名や亜種名から種の和名を推測しません。同じ学名に異なる名前があれば除外します。
- 12,580学名（2026-09-22）。国内の全種、BioCLIPの全候補を網羅したものではありません。Wikidataの日本語名が最新の標準和名と一致する保証はありません。
- `japanese-species-aliases.json` は出典を確認した表記差・旧学名の対応です。出典URLを各対応に記録し、文字の類似だけでは対応させません。

## 再生成

開発環境で `python3 scripts/update-japanese-species-names.py` を実行します。完全なSPARQL JSONを保存してある場合は `--input` でそのファイルを指定できます。取得失敗・JSON不完全・収録数が不自然に小さい場合は、既存辞書を書き換えません。

今回の取得では日本語記事と学名・日本語ラベルを先に取得し、項目IDを300件ずつ照会して種階級だけを残しました。これは辞書に記録した検索式と同じ条件です。データをそのままUIのHTMLとして解釈せず、テキストとして表示します。

利用者のPCでは通信せず、アプリに同梱した辞書を判定結果の表示時に読み込みます。追加モデルの再導入は不要です。和名の出典ボタンを利用者が押した場合のみブラウザで出典を開きます。

## 確認

- `node --test tests/project.test.mjs tests/species-names.test.mjs`
- UI操作: Viteを起動し、Playwrightが利用可能な開発環境で `node scripts/test-species-ui.mjs`。必要に応じて `DIGIVIEWER_PLAYWRIGHT_PACKAGE`、`DIGIVIEWER_TEST_BROWSER_CHANNEL=chrome`、`DIGIVIEWER_TEST_SCREENSHOT` を指定できます。
- UIテストは今回の5候補を固定応答として使い、実際の表示コンポーネントで和名、未収録、入力反映、明示確定までファイル名変更を要求しないことを確認します。モデル精度のテストではありません。
