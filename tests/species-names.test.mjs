import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/species-names.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { lookupJapaneseSpeciesName: lookup, japaneseNameCount } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('reported butterfly candidates resolve both modern and model scientific names', () => {
  for (const name of ['Parnara guttata', 'Parnara guttatus']) assert.equal(lookup(name)?.japaneseName, 'イチモンジセセリ');
  for (const name of ['Zinaida pellucida', 'Polytremis pellucida']) assert.equal(lookup(name)?.japaneseName, 'オオチャバネセセリ');
  assert.match(lookup('Parnara guttatus').aliasSourceUrl, /^https:\/\/www.gbif.org\//);
  assert.match(lookup('Polytremis pellucida').aliasSourceUrl, /^https:\/\/pmc.ncbi.nlm.nih.gov\//);
});

test('common Japanese insects and birds have Japanese labels rather than scientific-name fallbacks', () => {
  const expected = {
    'Papilio xuthus': 'ナミアゲハ', 'Lycaena phlaeas': 'ベニシジミ',
    'Orthetrum albistylum': 'シオカラトンボ', 'Bothrogonia ferruginea': 'ツマグロオオヨコバイ',
    'Pieris rapae': 'モンシロチョウ', 'Harmonia axyridis': 'ナミテントウ',
    'Passer montanus': 'スズメ', 'Parus minor': 'シジュウカラ',
    'Zosterops japonicus': 'メジロ', 'Hirundo rustica': 'ツバメ',
    'Anas platyrhynchos': 'マガモ', 'Ardea cinerea': 'アオサギ',
  };
  for (const [scientific, japanese] of Object.entries(expected)) {
    assert.equal(lookup(scientific)?.japaneseName, japanese, scientific);
    assert.match(lookup(scientific).sourceUrl, /^https:\/\/www.wikidata.org\/wiki\/Q\d+$/);
  }
});

test('unknown species, subspecies and similar spellings do not inherit a guessed Japanese name', () => {
  for (const name of ['Parnara unknown', 'Parnara guttatus fake', 'Parnara', 'toString', '__proto__', 'Polytremis pellucidus']) assert.equal(lookup(name), undefined, name);
  assert.equal(lookup('  Parnara   guttatus  ')?.japaneseName, 'イチモンジセセリ');
});

test('bundled snapshot is broad, attributed, unambiguous and independently usable offline', async () => {
  const data = JSON.parse(await fs.readFile('src/data/japanese-species-names.json', 'utf8'));
  assert.equal(data.license, 'CC0-1.0');
  assert.ok(japaneseNameCount > 8000);
  assert.equal(Object.keys(data.entries).length, data.count);
  for (const [name, [japanese, id]] of Object.entries(data.entries)) {
    assert.match(name, /^[A-Z][a-z]+ [a-z][a-z-]+$/);
    assert.match(japanese, /[ァ-ヺ]/);
    assert.match(id, /^Q[1-9][0-9]*$/);
    assert.ok(!Object.hasOwn(data.conflicts, name));
  }
  const aliases = JSON.parse(await fs.readFile('src/data/japanese-species-aliases.json', 'utf8'));
  for (const alias of Object.values(aliases)) assert.ok(Object.hasOwn(data.entries, alias.acceptedName));
});


test('domestic additions resolve the reported ladybird and preserve the existing correct name', () => {
  assert.equal(lookup('Coccinella ainu')?.japaneseName, 'アイヌテントウ');
  assert.equal(lookup('Coccinella septempunctata')?.japaneseName, 'ナナホシテントウ');
  assert.match(lookup('Coccinella ainu').sourceUrl, /^https:\/\/www\.nilim\.go\.jp\//);
  for (const [scientific, japanese] of Object.entries({
    'Nephus oshimensis': 'オシマヒメテントウ',
    'Hemithea aestivaria': 'キバラヒメアオシャク',
    'Protohermes immaculatus': 'アマミヘビトンボ',
  })) assert.equal(lookup(scientific)?.japaneseName, japanese, scientific);
  assert.equal(lookup('Coccinella madeup'), undefined);
  assert.equal(lookup('Parnara guttata guttata'), undefined);
});

test('additions have traceable sources, preserve all existing names, and exclude conflicts', async () => {
  const baseBytes = await fs.readFile('src/data/japanese-species-names.json');
  const base = JSON.parse(baseBytes);
  const extra = JSON.parse(await fs.readFile('src/data/japanese-species-names-supplement.json', 'utf8'));
  const audit = JSON.parse(await fs.readFile('docs/japanese-names-expansion-audit.json', 'utf8'));
  assert.equal(extra.baseSha256, createHash('sha256').update(baseBytes).digest('hex'));
  assert.equal(extra.count, Object.keys(extra.entries).length);
  assert.equal(japaneseNameCount, base.count + extra.count);
  assert.equal(audit.combinedCount, japaneseNameCount);
  assert.ok(extra.count > 20000);
  assert.equal(extra.sources['nilim-r07'].license, 'PDL-1.0');
  assert.equal(extra.sources.wikidata.license, 'CC0-1.0');
  for (const [name, [japanese]] of Object.entries(base.entries)) assert.equal(lookup(name)?.japaneseName, japanese, name);
  for (const [name, [japanese, source, record]] of Object.entries(extra.entries)) {
    assert.ok(!Object.hasOwn(base.entries, name));
    assert.ok(!Object.hasOwn(audit.newNamesExcluded, name));
    assert.match(name, /^[A-Z][a-z]+ [a-z][a-z-]+$/);
    assert.match(japanese, /^[ァ-ヺー・]+$/);
    assert.ok(Object.hasOwn(extra.sources, source));
    assert.match(record, source === 'wikidata' ? /^Q[1-9][0-9]*$/ : /^[0-9]+$/);
    assert.equal(lookup(name)?.japaneseName, japanese, name);
    assert.match(lookup(name).sourceUrl, /^https:\/\//);
  }
  for (const name of Object.keys(audit.newNamesExcluded)) assert.equal(lookup(name), undefined, name);
});
