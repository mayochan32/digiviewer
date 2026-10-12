import snapshot from './data/japanese-species-names.json';
import supplement from './data/japanese-species-names-supplement.json';
import aliases from './data/japanese-species-aliases.json';

type Entry = { japaneseName: string; sourceUrl: string; aliasSourceUrl?: string };
const names: Readonly<Record<string, readonly string[]>> = snapshot.entries;
const extraNames: Readonly<Record<string, readonly string[]>> = supplement.entries;
const synonyms: Readonly<Record<string, { acceptedName: string; source: string }>> = aliases;
export const japaneseNameCount = new Set([...Object.keys(names), ...Object.keys(extraNames)]).size;
export const japaneseNameDate = supplement.retrieved;
export const japaneseNameAttribution = supplement.sources['nilim-r07'].attribution;
export const japaneseNameSourceUrl = supplement.sources['nilim-r07'].sourceUrl;

function directName(key: string): Entry | undefined {
  if (Object.prototype.hasOwnProperty.call(names, key)) {
    const entry = names[key];
    return { japaneseName: entry[0], sourceUrl: `https://www.wikidata.org/wiki/${entry[1]}` };
  }
  if (!Object.prototype.hasOwnProperty.call(extraNames, key)) return undefined;
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
