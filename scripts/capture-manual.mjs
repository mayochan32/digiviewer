// Capture the production UI with explicit native fixtures, never modifying source photos.
// Start Vite, then set DIGIVIEWER_MANUAL_PHOTOS to a directory containing the six files below.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DIGIVIEWER_PLAYWRIGHT_PACKAGE || 'playwright');
const photos = [
  '20250429-benishijimi-01-4e9b8788.webp', '20250429-benishijimi-02-7165a7fa.webp',
  '20250429-benishijimi-03-a3fe9d47.webp', '20260426-benishijimi-01-7c08f2ec.webp',
  '20260530-shiokaratonbo-01-df931ad0.webp', '20260530-shiokaratonbo-02-2f143341.webp',
];
if (!process.env.DIGIVIEWER_MANUAL_PHOTOS) throw new Error('Set DIGIVIEWER_MANUAL_PHOTOS');
const images = await Promise.all(photos.map(name => readFile(path.join(process.env.DIGIVIEWER_MANUAL_PHOTOS, name))));
const output = path.resolve('docs/manual/images');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.DIGIVIEWER_TEST_BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/manual-fixture/*', async route => {
    const index = Number(new URL(route.request().url()).pathname.split('/').pop());
    await route.fulfill({ contentType: 'image/webp', body: images[index] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('digiviewer.species.japan', 'true');
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      convertFileSrc: file => '/manual-fixture/' + file.split('/').pop().split('_')[0],
      invoke: async (command, args) => {
        if (command === 'ensure_crop_directory') return '/manual/crops';
        if (command === 'app_version') return '0.6.1';
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open') return '/manual';
        if (command === 'load_review_state') return [];
        if (command === 'save_review_state') return;
        if (command === 'get_thumbnail') return args.request.path;
        if (command === 'scan_images') return Array.from({ length: 6 }, (_, i) => ({ path: '/manual/' + i + '_photo.webp', name: '観察_' + (i + 1).toString().padStart(2, '0') + '.webp', size: 120000, modified_at: 1790000000000 }));
        if (command === 'species_status') return { supported: true, windows: false, installed: true, enabled: true, busy: false, progress: '', error: '', geography: { complete: true } };
        if (command === 'species_identify') return {
          candidates: [
            { scientificName: 'Lycaena phlaeas', score: .8, wholeRank: 1, cropSupport: 5, japanRecords: 100 },
            { scientificName: 'Lycaena tityrus', score: .12, wholeRank: 2, cropSupport: 3, japanRecords: 0 },
            { scientificName: 'Lycaena alciphron', score: .05, wholeRank: 3, cropSupport: 2, japanRecords: 0 },
          ], otherScore: .03, device: 'mps', seconds: 10, japanApplied: true, geographyDate: '2026-09-22',
          warning: 'マニュアル用の表示例です。候補・数値は固定データで、この写真の実測結果ではありません。',
        };
        throw new Error('Unexpected capture command: ' + command);
      },
    };
  });
  await page.goto(process.env.DIGIVIEWER_TEST_URL || 'http://127.0.0.1:1420');
  await page.locator('#choose-folder').click();
  await page.locator('.thumb-check').first().click();
  await page.keyboard.press('ArrowRight');
  await page.locator('#species-default-name').fill('ベニシジミ');
  await page.locator('#species-default-name').blur();
  const shot = async (name, locator = page) => {
    await page.waitForFunction(() => document.querySelectorAll('.thumb img').length === 6 && !document.querySelector('.exif-bar')?.textContent.includes('読み込み中'));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
    await locator.screenshot({ path: path.join(output, name + '.png') });
  };
  await shot('overview');
  await page.locator('[data-compare-count="2"]').click();
  await shot('compare');
  await page.locator('[data-compare-count="1"]').click();
  const view = await page.locator('#viewer').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(view.x + view.width * .35, view.y + view.height * .25);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width * .7, view.y + view.height * .8, { steps: 15 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.locator('#crop-aspect').selectOption('3:2');
  await shot('crop');
  await page.locator('#crop-cancel').click();
  await page.locator('#settings-button').click();
  await shot('settings', page.locator('.settings-dialog'));
  await page.locator('#settings-close').click();
  await page.locator('#species-identify-button').click();
  await page.getByRole('button', { name: 'この写真を判定', exact: true }).click();
  await page.locator('#species-result-body li').first().waitFor();
  await shot('species-results');
  await page.getByRole('button', { name: 'この候補を種名欄に入れる' }).first().click();
  await page.getByRole('button', { name: '種名フィールドに設定', exact: true }).scrollIntoViewIfNeeded();
  await shot('species-actions');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Captured six current UI images; native calls and inference are documented fixtures.');
} finally { await browser.close(); }
