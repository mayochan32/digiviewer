import snapshot from './data/japanese-species-names.json';
import supplement from './data/japanese-species-names-supplement.json';
import aliases from './data/japanese-species-aliases.json';
import insects from './data/japanese-insect-names.json';
import extended from './data/japanese-insect-names-extended.json';

type Entry = { japaneseName: string; sourceUrl: string; aliasSourceUrl?: string; sourceAttribution?: string };
const names: Readonly<Record<string, readonly string[]>> = snapshot.entries;
const extraNames: Readonly<Record<string, readonly string[]>> = supplement.entries;
const insectNames: Readonly<Record<string, Entry>> = insects.entries;
const extendedNames: Readonly<Record<string, Entry>> = extended.entries;
const synonyms: Readonly<Record<string, { acceptedName: string; source: string }>> = aliases;
export const japaneseNameCount = new Set([...Object.keys(names), ...Object.keys(extraNames), ...Object.keys(insectNames), ...Object.keys(extendedNames)]).size;
export const japaneseNameDate = extended.retrieved;
export const japaneseAdditionalSources = Object.entries(extended.sources).filter(([key]) => key !== 'col').map(([, source]) => source);
export const japaneseInsectAttribution = insects.source.attribution;
export const japaneseInsectSourceUrl = insects.source.sourceUrl;
export const japaneseNameAttribution = supplement.sources['nilim-r07'].attribution;
export const japaneseNameSourceUrl = supplement.sources['nilim-r07'].sourceUrl;

function directName(key: string): Entry | undefined {
  if (Object.prototype.hasOwnProperty.call(names, key)) {
    const entry = names[key];
    return { japaneseName: entry[0], sourceUrl: `https://www.wikidata.org/wiki/${entry[1]}` };
  }
  if (!Object.prototype.hasOwnProperty.call(extraNames, key)) {
    if (Object.prototype.hasOwnProperty.call(insectNames, key)) return insectNames[key];
    return Object.prototype.hasOwnProperty.call(extendedNames, key) ? extendedNames[key] : undefined;
  }
  const [japaneseName, source, record] = extraNames[key];
  if (source === 'wikidata') return { japaneseName, sourceUrl: `https://www.wikidata.org/wiki/${record}` };
  if (source === 'nilim-r07') return { japaneseName, sourceUrl: japaneseNameSourceUrl };
  return undefined;
}

export function lookupJapaneseSpeciesName(scientificName: string): Entry | undefined {
  const key = scientificName.trim().replace(/\s+/g, ' ');
  const direct = directName(key);
  if (direct) return direct;
  const synonym = Object.prototype.hasOwnProperty.call(synonyms, key) ? synonyms[key] : undefined;
  const entry = synonym && directName(synonym.acceptedName);
  return entry ? { ...entry, aliasSourceUrl: synonym.source } : undefined;
}
