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
    window.__TAURI_INTERNALS__ = { invoke: async command => {
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
  // Mount the production component in its real HTML. Only native inference and rename are fixtures.
  await page.route('**/src/main.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import './styles.css';
    import { setupSpeciesOption } from '/src/species-option.ts';
    setupSpeciesOption({ native: true,
      photo: () => ({ path: '/fixtures/butterfly.jpg', name: '和名表示テスト（判定結果は固定）', url: '/docs/manual/images/overview.png' }),
      rename: async (path, name) => { window.__renames.push({ path, name }); }
    });
  ` }));
  await page.goto(process.env.DIGIVIEWER_TEST_URL || 'http://127.0.0.1:1420');
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
  await rows.nth(0).getByRole('button', { name: 'この候補を種名欄に入れる' }).click();
  await page.getByRole('button', { name: 'この写真のファイル名に追加' }).click();
  assert.deepEqual(await page.evaluate(() => window.__renames), [{ path: '/fixtures/butterfly.jpg', name: 'イチモンジセセリ' }]);
  assert.deepEqual(errors, []);
  if (process.env.DIGIVIEWER_TEST_SCREENSHOT) await page.locator('#species-result-dialog').screenshot({ path: process.env.DIGIVIEWER_TEST_SCREENSHOT });
  console.log('PASS: reported five candidates, Japanese labels, unknown fallbacks, selection without rename, and explicit Japanese rename');
} finally { await browser.close(); }
