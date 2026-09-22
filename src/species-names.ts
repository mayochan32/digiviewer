import snapshot from './data/japanese-species-names.json';
import aliases from './data/japanese-species-aliases.json';

type Entry = { japaneseName: string; sourceUrl: string; aliasSourceUrl?: string };
const names: Readonly<Record<string, readonly string[]>> = snapshot.entries;
const synonyms: Readonly<Record<string, { acceptedName: string; source: string }>> = aliases;
export const japaneseNameCount = snapshot.count;
export const japaneseNameDate = snapshot.retrieved;

export function lookupJapaneseSpeciesName(scientificName: string): Entry | undefined {
  const key = scientificName.trim().replace(/\s+/g, ' ');
  const direct = Object.prototype.hasOwnProperty.call(names, key) ? names[key] : undefined;
  const synonym = Object.prototype.hasOwnProperty.call(synonyms, key) ? synonyms[key] : undefined;
  const entry = direct ?? (synonym && Object.prototype.hasOwnProperty.call(names, synonym.acceptedName) ? names[synonym.acceptedName] : undefined);
  if (!entry) return undefined;
  return {
    japaneseName: entry[0],
    sourceUrl: `https://www.wikidata.org/wiki/${entry[1]}`,
    ...(!direct && synonym ? { aliasSourceUrl: synonym.source } : {}),
  };
}
