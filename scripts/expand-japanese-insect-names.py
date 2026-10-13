"""Build an offline insect-name overlay from a pinned, CC BY Catalogue of Life release.

No third-party Python packages. Network access is opt-in (--fetch); cached builds fail
closed if any required response is absent or incomplete. Existing names are immutable.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import hashlib
import http.client
import json
from pathlib import Path
import re
import threading
import time
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
DATASET = 316165  # COL 2026-08-26 XR, DOI 10.48580/dgyy9 (immutable release)
PREFIX = f'/dataset/{DATASET}'
PAGE = f'https://www.checklistbank.org/dataset/{DATASET}/taxon/'
BENIGN_ISSUES = {'homotypic consolidation'}


def scientific(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Z][a-z]+ [a-z][a-z-]+', value) is not None and value.split()[1] not in {'sp', 'spp', 'cf', 'aff'}


def species_name(usage):
    # A subgenus is optional notation within a species, not an infraspecific rank.
    # Accept it only in an explicit species record, never in the model's input key.
    value = usage.get('name', {}).get('scientificName', '')
    match = re.fullmatch(r'([A-Z][a-z]+)(?: \([A-Z][a-z]+\))? ([a-z][a-z-]+)', value)
    return f'{match[1]} {match[2]}' if match else None


def species(usage):
    name = usage.get('name', {})
    return (name.get('rank') == 'species' and scientific(species_name(usage))
            and name.get('code') in {None, 'zoological'} and name.get('type') == 'scientific'
            and not usage.get('namePhrase'))


def labels(row):
    return sorted({x['name'] for x in row.get('vernacularNames', [])
                   if x.get('language') == 'jpn' and re.fullmatch(r'[ァ-ヺー・]+', x.get('name', ''))})


def select_exact(response, name, family):
    rows = response.get('result', [])
    if response.get('offset') != 0 or response.get('total') != len(rows) or not response.get('last'):
        raise ValueError(f'Incomplete or malformed exact-search response: {name}')
    exact = [r for r in rows if r.get('usage', {}).get('name', {}).get('scientificName') == name]
    if len(exact) != 1:
        return None, 'no-exact-match' if not exact else 'ambiguous-name'
    row = exact[0]
    usage = row['usage']
    if usage.get('datasetKey') != DATASET or not species(usage):
        return None, 'not-an-exact-species'
    classification = {r['rank']: r['name'] for r in row.get('classification', [])}
    if classification.get('class') != 'Insecta' or classification.get('kingdom') != 'Animalia':
        return None, 'wrong-classification'
    if family and classification.get('family') != family:
        return None, 'different-family'
    if set(row.get('issues', [])) - BENIGN_ISSUES:
        return None, 'taxonomic-issue'
    if usage.get('status') not in {'accepted', 'synonym'} or usage.get('extinct'):
        return None, 'uncertain-status'
    if usage['status'] == 'synonym':
        accepted = usage.get('accepted', {})
        if not species(accepted) or accepted.get('status') != 'accepted' or accepted.get('id') != usage.get('parentId'):
            return None, 'unresolved-synonym'
    return row, None


def accepted_usage(row):
    usage = row['usage']
    return usage.get('accepted', usage)


def choose(row, info, existing):
    """Require all eligible names to agree, including existing homotypic synonyms."""
    usage, accepted = row['usage'], accepted_usage(row)
    taxon_id = accepted['id']
    suggestions = []
    for japanese in labels(row):
        suggestions.append((japanese, PAGE + usage['id'], None, 'col-vernacular', usage['name']['scientificName']))
    accepted_name = accepted['name']['scientificName']
    accepted_key = species_name(accepted)
    if accepted_key in existing:
        old = existing[accepted_key]
        suggestions.append((old['japaneseName'], old['sourceUrl'], PAGE + usage['id'], 'accepted-name', accepted_key))
    if info is not None:
        actual = info.get('usage', {})
        if (actual.get('datasetKey') != DATASET or actual.get('id') != taxon_id
                or not species(actual) or actual.get('status') != 'accepted'
                or actual['name']['scientificName'] != accepted_name):
            return None, 'mismatched-taxon-info', []
        if set(info.get('issues', [])) - BENIGN_ISSUES:
            return None, 'taxonomic-issue', []
        for japanese in labels(info):
            suggestions.append((japanese, PAGE + taxon_id, PAGE + usage['id'] if usage['id'] != taxon_id else None, 'col-vernacular', accepted_name))
        # Only explicitly homotypic, species-rank synonyms. Never promote subspecies,
        # use heterotypic synonyms or follow another newly added name recursively.
        for synonym in info.get('synonyms', {}).get('homotypic', []):
            name = species_name(synonym)
            if (species(synonym) and synonym.get('status') == 'synonym'
                    and synonym.get('parentId') == taxon_id and name in existing):
                old = existing[name]
                suggestions.append((old['japaneseName'], old['sourceUrl'], PAGE + taxon_id, 'homotypic-synonym', name))
    names = sorted({r[0] for r in suggestions})
    if len(names) != 1:
        return None, 'conflicting-japanese-names' if names else 'no-japanese-name', names
    # Retain the domestic/old dictionary as the source when a verified synonym exists.
    chosen = min(suggestions, key=lambda r: (r[3] == 'col-vernacular', r[4], r[1]))
    japanese, source, alias, method, matched = chosen
    result = {'japaneseName': japanese, 'sourceUrl': source}
    if alias:
        result['aliasSourceUrl'] = alias
    proof = {'method': method, 'usageId': usage['id'], 'acceptedId': taxon_id,
             'acceptedName': accepted_name, 'matchedName': matched,
             'issues': row.get('issues', [])}
    return (result, proof), None, names


class Cache:
    def __init__(self, directory, allow_network, retrieved):
        self.directory, self.allow_network, self.retrieved = directory, allow_network, retrieved
        directory.mkdir(parents=True, exist_ok=True)
        self.local = threading.local()
        self.used = {}
        self.lock = threading.Lock()

    def get(self, path):
        target = self.directory / (hashlib.sha256(path.encode()).hexdigest() + '.json')
        if not target.exists():
            if not self.allow_network:
                raise ValueError(f'Missing cached response: {path}. Use --fetch to retrieve it.')
            for attempt in range(5):
                try:
                    if not getattr(self.local, 'connection', None):
                        self.local.connection = http.client.HTTPSConnection('api.checklistbank.org', timeout=45)
                    self.local.connection.request('GET', path, headers={
                        'User-Agent': 'DigiViewer/0.7.0 (https://github.com/mayochan32/digiviewer; offline Japanese-name dictionary)',
                        'Accept': 'application/json'})
                    response = self.local.connection.getresponse()
                    raw = response.read()
                    if response.status != 200:
                        raise ValueError(f'HTTP {response.status}: {path}')
                    data = json.loads(raw)
                    target.write_text(json.dumps({'path': path, 'retrieved': self.retrieved, 'data': data}, ensure_ascii=False) + '\n')
                    time.sleep(.1)
                    break
                except Exception:
                    if getattr(self.local, 'connection', None):
                        self.local.connection.close()
                        self.local.connection = None
                    if attempt == 4:
                        raise
                    time.sleep(2 ** attempt)
        envelope = json.loads(target.read_text())
        if envelope['path'] != path or envelope['retrieved'] != self.retrieved:
            raise ValueError(f'Wrong response path or retrieval date: {target}')
        with self.lock:
            self.used[path] = hashlib.sha256(target.read_bytes()).hexdigest()
        return envelope['data']

    def search(self, name):
        return self.get(PREFIX + '/nameusage/search?' + urllib.parse.urlencode({
            'q': name, 'type': 'exact', 'content': 'scientificName', 'limit': 100}))


def load_existing(root):
    paths = ['src/data/japanese-species-names.json', 'src/data/japanese-species-names-supplement.json',
             'src/data/japanese-species-aliases.json', 'docs/japanese-names-expansion-audit.json']
    base, supplement, aliases, audit = [json.loads((root / p).read_text()) for p in paths]
    existing = {k: {'japaneseName': v[0], 'sourceUrl': f'https://www.wikidata.org/wiki/{v[1]}'} for k, v in base['entries'].items()}
    for name, (japanese, source, record) in supplement['entries'].items():
        existing[name] = {'japaneseName': japanese, 'sourceUrl': f'https://www.wikidata.org/wiki/{record}' if source == 'wikidata' else supplement['sources'][source]['sourceUrl']}
    direct_count = len(existing)
    for name, alias in aliases.items():
        existing.setdefault(name, existing[alias['acceptedName']])
    return existing, direct_count, set(audit['newNamesExcluded']), {p: digest(root / p) for p in paths}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--retrieved', required=True)
    parser.add_argument('--model-labels', type=Path, required=True)
    parser.add_argument('--japan-names', type=Path, required=True)
    parser.add_argument('--output-root', type=Path, default=ROOT)
    args = parser.parse_args()
    date.fromisoformat(args.retrieved)
    existing, direct_count, blocked, input_hashes = load_existing(args.output_root)
    japan = json.loads(args.japan_names.read_text())
    if not japan.get('complete'):
        raise ValueError('Incomplete Japan occurrence snapshot')
    classes, families = defaultdict(set), defaultdict(set)
    for taxonomy, _ in json.loads(args.model_labels.read_text()):
        name = ' '.join((taxonomy[5] + ' ' + taxonomy[6]).split()[:2])
        if japan['names'].get(name, 0) > 0:
            classes['all'].add(name)
            if taxonomy[2] in {'Insecta', 'Aves'}:
                classes[taxonomy[2]].add(name)
            if taxonomy[2] == 'Insecta':
                families[name].add(taxonomy[4])
    targets = sorted(classes['Insecta'] - existing.keys())
    cache = Cache(args.cache, args.fetch, args.retrieved)
    metadata = cache.get(PREFIX)
    if metadata.get('key') != DATASET or metadata.get('license') != 'cc by' or metadata.get('doi') != '10.48580/dgyy9':
        raise ValueError('Unexpected source identity or license')
    selected, excluded = {}, {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i, (name, response) in enumerate(zip(targets, pool.map(cache.search, targets)), 1):
            row, reason = select_exact(response, name, next(iter(families[name])) if len(families[name]) == 1 else None)
            if name in blocked:
                reason = 'previous-source-conflict'
            if len(families[name]) != 1:
                reason = 'ambiguous-model-family'
            if reason:
                excluded[name] = {'reason': reason}
            else:
                selected[name] = row
            if i % 500 == 0:
                print(f'Exact searches {i}/{len(targets)}', flush=True)
    # Fetch full accepted-species records for ALL matches: this checks Japanese-name
    # consistency across accepted usages and known homotypic synonyms as well.
    ids = sorted({accepted_usage(row)['id'] for row in selected.values()})
    infos = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i, (identifier, info) in enumerate(zip(ids, pool.map(lambda key: cache.get(PREFIX + '/taxon/' + urllib.parse.quote(key, safe='') + '/info'), ids)), 1):
            infos[identifier] = info
            if i % 500 == 0:
                print(f'Species records {i}/{len(ids)}', flush=True)
    entries, proofs = {}, {}
    for name, row in selected.items():
        result, reason, names = choose(row, infos[accepted_usage(row)['id']], existing)
        if reason:
            excluded[name] = {'reason': reason, 'japaneseNames': names}
        else:
            entries[name], proofs[name] = result
    before, after = set(existing), set(existing) | entries.keys()
    coverage = {key: {'total': len(names), 'before': len(names & before), 'after': len(names & after)} for key, names in sorted(classes.items())}
    source = {'title': 'Catalogue of Life', 'version': metadata['version'], 'datasetKey': DATASET,
              'doi': metadata['doi'], 'sourceUrl': 'https://doi.org/' + metadata['doi'],
              'license': 'CC-BY-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
              'attribution': 'Bánki et al., Catalogue of Life (2026-08-26 XR, CC BY 4.0) をDigiViewerが抽出・加工。',
              'retrieved': args.retrieved}
    result = {'schema': 1, 'retrieved': args.retrieved, 'count': len(entries), 'source': source,
              'inputSha256': input_hashes, 'entries': entries}
    report = {'retrieved': args.retrieved, 'source': source, 'targetCount': len(targets),
              'additionalCount': len(entries), 'combinedCount': direct_count + len(entries),
              'addedByMethod': dict(Counter(v['method'] for v in proofs.values())),
              'exclusionCounts': dict(Counter(v['reason'] for v in excluded.values())),
              'modelJapanCoverage': {'japanRetrieved': japan['fetched'], 'labelsSha256': digest(args.model_labels),
                                    'japanSha256': digest(args.japan_names), 'counts': coverage},
              'entries': proofs, 'excluded': excluded, 'responseSha256': dict(sorted(cache.used.items()))}
    # Do not emit any partial snapshot after a network, schema or validation failure.
    for relative, data in [('src/data/japanese-insect-names.json', result), ('docs/japanese-insect-names-audit.json', report)]:
        (args.output_root / relative).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in {'entries', 'excluded', 'responseSha256'}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
