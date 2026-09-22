// Optional browser regression: start Vite first, provide an installed Playwright package.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DIGIVIEWER_PLAYWRIGHT_PACKAGE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.DIGIVIEWER_TEST_BROWSER_CHANNEL ? { channel: process.env.DIGIVIEWER_TEST_BROWSER_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error('UI error:', error); });
  await page.addInitScript(() => {
    window.__renames = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      convertFileSrc: () => '/docs/manual/images/overview.png',
      invoke: async (command, args) => {
      if (command === 'ensure_crop_directory') return '/fixtures/crops';
      if (command === 'app_version') return '0.6.1';
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:dialog|open') return '/fixtures';
      if (command === 'load_review_state') return [];
      if (command === 'save_review_state') return;
      if (command === 'get_thumbnail') return null;
      if (command === 'scan_images') return [{ path: '/fixtures/butterfly.jpg', name: 'butterfly.jpg', size: 1000, modified_at: 1 }];
      if (command === 'rename_images') {
        if (window.__failRename) throw new Error('テスト用の変更失敗');
        const path = args.request.paths[0], name = args.request.speciesName;
        window.__renames.push({ path, name });
        return [{ old_path: path, path: '/fixtures/butterfly_' + name + '.jpg', name: 'butterfly_' + name + '.jpg', size: 1000, modified_at: 1 }];
      }
      if (command === 'species_status') return { supported: true, windows: false, installed: true, enabled: true, busy: false, progress: '', error: '', geography: { complete: true } };
      if (command === 'species_identify') return {
        candidates: [
          { scientificName: 'Parnara guttatus', score: .894, wholeRank: 1, cropSupport: 5, japanRecords: 1765 },
          { scientificName: 'Polytremis pellucida', score: .038, wholeRank: 4, cropSupport: 4, japanRecords: 1503 },
          { scientificName: 'Polytremis zina', score: .035, wholeRank: 3, cropSupport: 5, japanRecords: 1 },
          { scientificName: 'Parnara apostata', score: .019, wholeRank: 2, cropSupport: 4, japanRecords: 6 },
          { scientificName: 'Pelopidas sinensis', score: .006, wholeRank: 5, cropSupport: 3, japanRecords: 1 },
        ], otherScore: .008, device: 'mps', seconds: 14.31, japanApplied: true, geographyDate: '2026-09-22',
      };
      throw new Error('Unexpected native command: ' + command);
    }};
  });
  // Run the complete production UI; only native calls are fixtures.
  await page.goto(process.env.DIGIVIEWER_TEST_URL || 'http://127.0.0.1:1420');
  await page.locator('#choose-folder').click();
  await page.locator('.thumb-check').first().click();
  await page.locator('#append-species').click();
  assert.equal(await page.locator('#species-name-input').inputValue(), '');
  await page.locator('#species-cancel').click();
  await page.locator('#species-default-name').fill('ナミアゲハ');
  await page.locator('#append-species').click();
  assert.equal(await page.locator('#species-name-input').inputValue(), 'ナミアゲハ');
  await page.locator('#species-cancel').click();
  for (const width of [860, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    const analysis = await page.locator('#analyze-similarity').boundingBox();
    const species = await page.locator('#species-identify-button').boundingBox();
    if (width >= 1280) assert.equal(analysis.y, species.y, `same toolbar row at ${width}px`);
    assert.equal(await page.locator('.similarity-toolbar #species-identify-button').count(), 1);
    assert.equal((await page.locator('#species-default-name').boundingBox()).width, 300);
    assert.ok(await page.locator('#species-default-name').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  if (process.env.DIGIVIEWER_TEST_SCREENSHOT) await page.screenshot({ path: process.env.DIGIVIEWER_TEST_SCREENSHOT + '.main.png' });
  await page.locator('#species-identify-button').click();
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'この写真を判定', exact: true }).click();
  const rows = page.locator('#species-result-body li');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 5);
  assert.equal(await rows.nth(0).locator('strong').innerText(), 'イチモンジセセリ — Parnara guttatus');
  assert.equal(await rows.nth(1).locator('strong').innerText(), 'オオチャバネセセリ — Polytremis pellucida');
  for (const index of [2, 3, 4]) assert.match(await rows.nth(index).innerText(), /和名未収録/);
  await rows.nth(0).getByRole('button', { name: 'この候補を種名欄に入れる' }).click();
  assert.equal(await page.locator('#species-result-body input[type=text]').inputValue(), 'イチモンジセセリ');
  assert.deepEqual(await page.evaluate(() => window.__renames), []);
  await rows.nth(1).getByRole('button', { name: 'この候補を種名欄に入れる' }).click();
  assert.equal(await page.locator('#species-result-body input[type=text]').inputValue(), 'オオチャバネセセリ');
  await page.getByRole('button', { name: '種名フィールドに設定', exact: true }).click();
  assert.equal(await page.locator('#species-default-name').inputValue(), 'オオチャバネセセリ');
  assert.deepEqual(await page.evaluate(() => window.__renames), []);
  await rows.nth(0).getByRole('button', { name: 'この候補を種名欄に入れる' }).click();
  await page.evaluate(() => { window.__failRename = true; });
  await page.getByRole('button', { name: 'この写真のファイル名に追加' }).click();
  await page.getByRole('status').filter({ hasText: 'テスト用の変更失敗' }).waitFor();
  assert.equal(await page.locator('#species-default-name').inputValue(), 'オオチャバネセセリ');
  await page.evaluate(() => { window.__failRename = false; });
  await page.getByRole('button', { name: 'この写真のファイル名に追加' }).click();
  await page.getByRole('status').filter({ hasText: '種名フィールドにも設定しました' }).waitFor();
  assert.equal(await page.locator('#species-default-name').inputValue(), 'イチモンジセセリ');
  assert.deepEqual(await page.evaluate(() => window.__renames), [{ path: '/fixtures/butterfly.jpg', name: 'イチモンジセセリ' }]);
  assert.deepEqual(errors, []);
  if (process.env.DIGIVIEWER_TEST_SCREENSHOT) await page.locator('#species-result-dialog').screenshot({ path: process.env.DIGIVIEWER_TEST_SCREENSHOT });
  await page.locator('#species-result-close').click();
  await page.locator('#append-species').click();
  assert.equal(await page.locator('#species-name-input').inputValue(), 'イチモンジセセリ');
  await page.locator('#species-cancel').click();
  await page.locator('#species-default-name').fill('');
  await page.locator('#append-species').click();
  assert.equal(await page.locator('#species-name-input').inputValue(), '');
  console.log('PASS: full production UI, toolbar layout, empty/prefilled defaults, Japanese names, field-only action, failed rename preservation, successful rename and default propagation');
} finally { await browser.close(); }
