import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(root, relative), 'utf8');

test('application version is consistent across frontend, backend and packaging', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
  const cargo = await read('src-tauri/Cargo.toml');
  const cargoLock = await read('src-tauri/Cargo.lock');
  const html = await read('index.html');
  assert.equal(packageJson.version, '0.6.1');
  for (const version of [lock.version, lock.packages[''].version, config.version, cargo.match(/^version = "([^"]+)"/m)[1], cargoLock.match(/name = "digiviewer"\r?\nversion = "([^"]+)"/)[1], html.match(/id="app-version"[^>]*>v([^<]+)</)[1]]) assert.equal(version, packageJson.version);
  assert.equal(config.identifier, 'com.digiviewer.app');
});

test('runtime sources have no dependency on the photo publishing project or local admin API', async () => {
  async function check(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) await check(relative);
      else if (/\.(ts|rs|py)$/.test(entry.name)) {
        const source = await read(relative);
        assert.doesNotMatch(source, /admin-server|api\/observations|observations\.json|taxa\.yml|inuyama-ikimono|8787|8789|bioclip-eval|bioclip-improvements|デジタル観察のススメ|デジタル観察のススメ|\/Users\/hal/, relative);
      }
    }
  }
  await check('src'); await check('src-tauri/src'); await check('src-tauri/species');
  const packageJson = JSON.parse(await read('package.json'));
  for (const version of Object.values({ ...packageJson.dependencies, ...packageJson.devDependencies })) assert.doesNotMatch(version, /^(file:|link:|workspace:)|\.\.\//);
});
