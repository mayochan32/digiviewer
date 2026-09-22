import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';

type Photo = { path: string; name: string; url: string };
type Status = { supported: boolean; windows: boolean; installed: boolean; enabled: boolean; busy: boolean; progress: string; error: string; geography?: { complete: boolean }; backend?: string };
type Candidate = { scientificName: string; score: number; wholeRank: number | null; cropSupport: number; japanRecords: number | null };
type Result = { candidates: Candidate[]; otherScore: number; device: string; seconds: number; japanApplied: boolean; geographyDate?: string; warning?: string };
// An intentionally small, explicit dictionary. Unregistered names remain scientific names.
const japaneseNames: Record<string,string> = {
  'Papilio xuthus': 'ナミアゲハ', 'Lycaena phlaeas': 'ベニシジミ', 'Orthetrum albistylum': 'シオカラトンボ',
  'Bothrogonia ferruginea': 'ツマグロオオヨコバイ', 'Passer montanus': 'スズメ', 'Parus minor': 'シジュウカラ',
  'Zosterops japonicus': 'メジロ', 'Pieris rapae': 'モンシロチョウ', 'Harmonia axyridis': 'ナミテントウ',
};
const element = (tag: string, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const button = (text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'tool-button'; node.textContent = text; node.addEventListener('click', action); return node; };

export function setupSpeciesOption(options: { native: boolean; photo: () => Photo | null | undefined; rename: (path: string, name: string) => Promise<void> }) {
  const settings = document.querySelector<HTMLElement>('#species-settings')!;
  const statusText = document.querySelector<HTMLElement>('#species-setting-status')!;
  const controls = document.querySelector<HTMLElement>('#species-setting-controls')!;
  const launch = document.querySelector<HTMLButtonElement>('#species-identify-button')!;
  const dialog = document.querySelector<HTMLElement>('#species-result-dialog')!;
  const body = document.querySelector<HTMLElement>('#species-result-body')!;
  let status: Status | null = null, poll: ReturnType<typeof setTimeout> | null = null;
  let captured: Photo | null = null, generation = 0;
  const close = () => { dialog.hidden = true; generation++; launch.focus(); };
  document.querySelector('#species-result-close')!.addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });

  function renderSettings() {
    controls.replaceChildren();
    launch.hidden = !status?.enabled;
    launch.disabled = status?.busy ?? false;
    if (!status) return;
    statusText.textContent = status.error || (status.busy ? status.progress : status.enabled ? '有効です。表示中の写真を「種名推測」から判定できます。' : status.installed ? '導入済み・無効です。' : '未導入です。必要な場合だけ追加してください。');
    if (!status.supported) { statusText.textContent = '現在の対応環境はApple Silicon MacとWindows x64です。'; return; }
    if (status.busy) return;
    if (!status.enabled) {
      const select = document.createElement('select'); select.setAttribute('aria-label', '種名推測の実行方式');
      select.add(new Option(status.windows ? 'CPU（追加ドライバー不要）' : 'Mac標準（GPU自動・CPU切替可）', 'cpu'));
      if (status.windows) select.add(new Option('NVIDIA GPU（対応ドライバー導入済み）', 'cuda'));
      select.value = status.backend ?? 'cpu';
      controls.append(select, button(status.installed ? '再導入' : '無料の追加機能を導入', () => void act('species_install', { backend: select.value })));
    }
    if (status.installed) controls.append(button(status.enabled ? '無効にする' : '有効にする', () => void act('species_enable', { value: !status!.enabled })));
    controls.append(button('追加データを削除', () => void (async () => {
      const accepted = await confirm('種名推測用のPython・モデル・キャッシュを削除します。写真と通常の設定は残ります。', { title: '種名推測の追加データを削除', kind: 'warning' });
      if (accepted) await act('species_uninstall');
    })().catch(error => { statusText.textContent = String(error); })));
  }
  async function refresh() {
    if (!options.native) { statusText.textContent = '種名推測はインストールしたDigiViewerアプリで利用できます。'; return; }
    try {
      status = await invoke<Status>('species_status'); renderSettings();
      if (poll) clearTimeout(poll);
      if (status.busy) poll = setTimeout(() => void refresh(), 1500);
    } catch (error) { statusText.textContent = String(error); }
  }
  async function act(command: string, args: Record<string, unknown> = {}) {
    controls.querySelectorAll('button,select').forEach(node => { (node as HTMLButtonElement).disabled = true; });
    try { await invoke(command, args); await refresh(); }
    catch (error) { await refresh(); statusText.textContent = String(error); }
  }
  document.querySelector('#settings-button')!.addEventListener('click', () => void refresh());
  // The setting is stored natively so packaged app restarts keep the user's choice.
  void refresh();

  launch.addEventListener('click', () => {
    const photo = options.photo();
    if (!photo) { window.alert('判定する写真を表示してください。'); return; }
    captured = { path: photo.path, name: photo.name, url: photo.url };
    generation++; const requestGeneration = generation, target = captured;
    body.replaceChildren(); dialog.hidden = false;
    const img = document.createElement('img'); img.src = target.url; img.alt = target.name; img.className = 'species-preview';
    const heading = element('p', target.name); heading.className = 'species-filename';
    const japanLabel = element('label'); const japan = document.createElement('input'); japan.type = 'checkbox'; japan.checked = localStorage.getItem('digiviewer.species.japan') === 'true'; japan.disabled = !status?.geography?.complete;
    japanLabel.append(japan, document.createTextNode('日本で撮影した写真として生息記録を考慮する'));
    const cpuLabel = element('label'); const cpu = document.createElement('input'); cpu.type = 'checkbox'; cpuLabel.append(cpu, document.createTextNode('CPUで判定する'));
    const message = element('p'); message.setAttribute('role', 'status');
    const results = element('div');
    const run = button('この写真を判定', () => void (async () => {
      run.disabled = true; results.replaceChildren(); message.textContent = '判定中です。CPUでは数分かかることがあります。';
      localStorage.setItem('digiviewer.species.japan', String(japan.checked));
      try {
        const result = await invoke<Result>('species_identify', { path: target.path, japan: japan.checked && !japan.disabled, cpu: cpu.checked });
        if (generation !== requestGeneration || dialog.hidden) return;
        message.textContent = `${result.seconds}秒 / ${result.device.toUpperCase()} / ${result.japanApplied ? '日本の記録を考慮' : '地域補正なし'}`;
        results.append(element('p', '数値は候補間の相対スコアです。正解である確率ではありません。候補に正解が含まれないこともあります。'));
        if (result.warning) results.append(element('p', result.warning));
        const draftLabel = element('label', '確認した種名（ファイル名に追加する文字）'); const draft = document.createElement('input'); draft.type = 'text'; draft.placeholder = '候補から選ぶか、自分で入力'; draftLabel.append(draft);
        const rename = button('この写真のファイル名に追加', () => void (async () => {
          const name = draft.value.trim(); if (!name) { message.textContent = '確認した種名を入力してください。'; return; }
          rename.disabled = true;
          try { await options.rename(target.path, name); message.textContent = '確認した名前をファイル名に追加しました。'; run.disabled = true; }
          catch (error) { message.textContent = String(error); rename.disabled = false; }
        })());
        const list = element('ol');
        for (const candidate of result.candidates) {
          const row = element('li');
          const name = japaneseNames[candidate.scientificName];
          row.append(element('strong', `${name ?? '和名未登録'} — ${candidate.scientificName}`));
          row.append(element('p', `相対スコア ${(candidate.score * 100).toFixed(1)}% ・ 写真全体: ${candidate.wholeRank ? candidate.wholeRank + '位' : '上位5件外'} ・ 切り出し5箇所中${candidate.cropSupport}箇所で上位5件`));
          row.append(element('p', candidate.japanRecords === null ? '日本の生息記録は未取得です。' : candidate.japanRecords ? `日本のGBIF記録 ${candidate.japanRecords.toLocaleString()}件（${result.geographyDate}取得）` : '取得した日本の記録に学名の一致はありません。日本にいないという意味ではありません。'));
          row.append(button('この候補を種名欄に入れる', () => { draft.value = name ?? candidate.scientificName; message.textContent = '種名欄に入れました。まだファイル名は変更していません。写真と照合して確認してください。'; }));
          list.append(row);
        }
        results.append(list, element('p', `表示外の候補: ${(result.otherScore * 100).toFixed(1)}%。切り出しは同じ写真の補助情報です。模様などの形態的な根拠をAIが説明しているものではありません。国内記録は飼育・誤記録などを含む可能性があります。`), draftLabel, rename);
      } catch (error) { message.textContent = `判定できませんでした。${String(error)}`; }
      finally { run.disabled = false; await refresh(); }
    })());
    body.append(img, heading, japanLabel, cpuLabel, run, message, results);
    if (!status?.geography?.complete) body.append(element('p', '日本の記録が未取得のため地域補正は使えません。設定から再導入すると取得を再試行できます。'));
    run.focus();
  });
  settings.setAttribute('aria-label', '種名推測の設定');
}
