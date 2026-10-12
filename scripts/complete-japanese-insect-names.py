"""Extend the insect dictionary with audited taxonomy matches and source records.

This developer-only builder uses cached public metadata, never user photographs.
It adds exact species mappings without changing existing names or inference scores.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import copy
import csv
from datetime import date
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
COL_KEY = '7ddf754f-d193-4cc9-b351-99906754a03b'
INAT_KEY = '738041eb-6a2d-449f-8007-0ee4793195d3'


def load_col(root):
    spec = importlib.util.spec_from_file_location('col_builder', root / 'scripts/expand-japanese-insect-names.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


class PublicCache:
    def __init__(self, directory, fetch, retrieved):
        self.directory, self.fetch, self.retrieved = directory, fetch, retrieved
        directory.mkdir(parents=True, exist_ok=True)
        self.used = {}

    def get(self, url):
        if not url.startswith(('https://api.gbif.org/', 'https://api.checklistbank.org/')):
            raise ValueError('Unexpected API host')
        path = self.directory / (hashlib.sha256(url.encode()).hexdigest() + '.json')
        if not path.exists():
            if not self.fetch:
                raise ValueError('Missing cached response: ' + url)
            for attempt in range(5):
                try:
                    request = urllib.request.Request(url, headers={'User-Agent': 'DigiViewer/0.6.2 (offline Japanese-name dictionary)'})
                    with urllib.request.urlopen(request, timeout=45) as response:
                        data = json.load(response)
                    write(path, {'url': url, 'retrieved': self.retrieved, 'data': data})
                    time.sleep(.15)
                    break
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        write(path, {'url': url, 'retrieved': self.retrieved, 'data': {'httpStatus': 404}})
                        break
                    if attempt == 4:
                        raise
                    time.sleep(2 ** attempt)
                except Exception:
                    if attempt == 4:
                        raise
                    time.sleep(2 ** attempt)
        value = read(path)
        if value.get('url') != url or value.get('retrieved') != self.retrieved:
            raise ValueError('Unexpected cached response: ' + str(path))
        self.used[url] = digest(path)
        return value['data']


def select_equivalent(col, response, name, family):
    """Disambiguate by class/family, then require one accepted species ID.

    Do not discard a competing same-family taxon just because its record has an
    issue flag. All relevant records must pass the existing safety conditions.
    """
    rows = response.get('result', [])
    if response.get('offset') != 0 or response.get('total') != len(rows) or not response.get('last'):
        raise ValueError('Incomplete search response: ' + name)
    exact = [r for r in rows if col.species_name(r.get('usage', {})) == name]
    if not exact:
        return None, 'no-exact-match'
    relevant = []
    for r in exact:
        cl = {v['rank']: v['name'] for v in r.get('classification', [])}
        if cl.get('kingdom') == 'Animalia' and cl.get('class') == 'Insecta' and cl.get('family') == family:
            relevant.append(r)
    if not relevant:
        return None, 'different-classification'
    for r in relevant:
        # Validate the full source spelling with the established strict selector.
        _, reason = col.select_exact({'offset': 0, 'total': 1, 'last': True, 'result': [r]},
                                     r['usage']['name']['scientificName'], family)
        if reason:
            return None, reason
    if len({col.accepted_usage(r)['id'] for r in relevant}) != 1:
        return None, 'different-accepted-species'
    representative = min(relevant, key=lambda r: (r['usage']['status'] != 'accepted', r['usage']['id']))
    result = copy.deepcopy(representative)
    result['equivalentRows'] = relevant
    return result, None


def match_identifier(response, name, family):
    """A match service only discovers IDs; a pinned COL record must verify them."""
    usage = response.get('usage', {})
    diagnostics = response.get('diagnostics', {})
    classification = {v['rank']: v['name'] for v in response.get('classification', [])}
    if (diagnostics.get('matchType') != 'EXACT' or diagnostics.get('issues')
            or usage.get('canonicalName') != name or usage.get('rank') != 'SPECIES'
            or usage.get('type') != 'SCIENTIFIC' or usage.get('code') != 'ZOOLOGICAL'
            or usage.get('status') != 'ACCEPTED' or response.get('synonym')
            or classification.get('KINGDOM') != 'Animalia' or classification.get('CLASS') != 'Insecta'
            or classification.get('FAMILY') != family):
        return None
    return usage.get('key')


def choose_equivalent(col, row, info, existing):
    alternatives, reason, names = [], None, set()
    for candidate in row.get('equivalentRows', [row]):
        result, error, labels = col.choose(candidate, info, existing)
        names.update(labels)
        if error and error != 'no-japanese-name':
            reason = error
        if result:
            alternatives.append(result)
    if reason or len(names) > 1:
        return None, reason or 'conflicting-japanese-names', sorted(names)
    if not alternatives:
        return None, 'no-japanese-name', []
    entry, proof = alternatives[0]
    proof = dict(proof, equivalentUsageIds=sorted({r['usage']['id'] for r in row.get('equivalentRows', [row])}))
    return (entry, proof), None, sorted(names)


def cohort(labels, japan):
    groups, families = defaultdict(set), defaultdict(set)
    if not japan.get('complete'):
        raise ValueError('Incomplete Japan snapshot')
    for taxonomy, _ in labels:
        name = ' '.join((taxonomy[5] + ' ' + taxonomy[6]).split()[:2])
        if japan['names'].get(name, 0) > 0:
            groups['all'].add(name)
            if taxonomy[2] in {'Insecta', 'Aves'}:
                groups[taxonomy[2]].add(name)
            if taxonomy[2] == 'Insecta':
                families[name].add(taxonomy[4])
    return groups, families


def inat_candidates(archive, metadata, targets, families):
    """Read species-level Japanese names; never truncate an infraspecific name."""
    if (metadata.get('key') != 139831 or metadata.get('title') != 'iNaturalist Taxonomy'
            or metadata.get('license') != 'cc by' or not metadata.get('versionDoi')):
        raise ValueError('Unexpected iNaturalist identity or license')
    matched, japanese = defaultdict(list), defaultdict(list)
    with zipfile.ZipFile(archive) as z:
        eml = ET.fromstring(z.read('eml.xml'))
        if eml.findtext('./dataset/title', '').strip() != 'iNaturalist Taxonomy' or eml.findtext('./dataset/pubDate') != metadata['version']:
            raise ValueError('iNaturalist archive and licensed source versions differ')
        for row in csv.DictReader(io.TextIOWrapper(z.open('VernacularNames-japanese.csv'), encoding='utf8')):
            if row['language'] == 'ja' and re.fullmatch(r'[ァ-ヺー・]+', row['vernacularName']):
                japanese[row['id']].append(row)
        for row in csv.DictReader(io.TextIOWrapper(z.open('taxa.csv'), encoding='utf8')):
            name = row['scientificName']
            if (name in targets and row['id'] in japanese and row['kingdom'] == 'Animalia'
                    and row['class'] == 'Insecta' and row['taxonRank'] == 'species'
                    and not row['infraspecificEpithet'] and row['genus'] + ' ' + row['specificEpithet'] == name):
                matched[name].append({'taxon': row, 'names': japanese[row['id']]})
    result = {}
    for name, rows in matched.items():
        names = sorted({r['vernacularName'] for v in rows for r in v['names']})
        reason = None
        if len(rows) != 1:
            reason = 'inat-multiple-taxa'
        elif families[name] != {rows[0]['taxon']['family']}:
            reason = 'inat-different-family'
        elif len(names) != 1:
            reason = 'inat-conflicting-japanese-names'
        result[name] = {'records': rows, 'japaneseNames': names, 'reason': reason}
    return result


def domestic_candidates(document, families):
    if document.get('source', {}).get('license') != 'PDL-1.0' or document['source'].get('version') != '1997':
        raise ValueError('Unexpected domestic source or license')
    groups = defaultdict(list)
    for row in document['records']:
        name = row['scientificName']
        if not re.fullmatch(r'[A-Z][a-z]+ [a-z][a-z-]+', name) or not re.fullmatch(r'[ァ-ヺー・]+', row['japaneseName']):
            raise ValueError('Invalid domestic species row')
        if name in families:
            groups[name].append(row)
    result = {}
    for name, rows in groups.items():
        labels = sorted({r['japaneseName'] for r in rows})
        reason = None
        if len(labels) != 1:
            reason = 'domestic-conflicting-names'
        elif any(families[name] != {r['family']} for r in rows):
            reason = 'domestic-different-family'
        result[name] = {'records': rows, 'japaneseNames': labels, 'reason': reason}
    return result


def exact_specimen_name(name, source):
    """Allow author/year after an explicit binomial, never a third epithet."""
    return bool(re.fullmatch(re.escape(name) + r'(?: (?:\([A-Z][^)]*\)|[A-Z][A-Za-z.\- &,\[\]0-9]*))?', source.get('学名', ''))
                and not source.get('亜種以下のタクソン', '').strip()
                and source.get('分類群ランク', '').strip().lower() in {'', 'species', 'sp.'}
                and re.fullmatch(r'[ァ-ヺー・]+', source.get('和名', ''))
                and not source.get('同定に関する補足情報', '')
                and not source.get('同定に関する補足情報（日本語）', ''))


def validate_specimen(name, family, japanese, record):
    data, source = record.get('gbif', {}), record['specimen']
    license_url = record.get('license')
    return (license_url in {'http://creativecommons.org/licenses/by/4.0/legalcode', 'https://creativecommons.org/licenses/by/4.0/legalcode',
                            'http://creativecommons.org/publicdomain/zero/1.0/legalcode', 'https://creativecommons.org/publicdomain/zero/1.0/legalcode'}
            and record.get('datasetLicense') == license_url
            and data.get('class') == 'Insecta' and data.get('family') == family
            and data.get('species') == name and data.get('taxonRank') == 'SPECIES'
            and data.get('taxonomicStatus') == 'ACCEPTED' and data.get('vernacularName') == japanese
            and not any(v.startswith('TAXON_MATCH_') for v in data.get('issues', []))
            and source.get('和名') == japanese and exact_specimen_name(name, source)
            and source.get('管理ID') and source.get('機関コード') and source.get('カタログ番号')
            and data.get('institutionCode') == source.get('機関コード')
            and data.get('collectionCode') == source.get('コレクションコード')
            and data.get('catalogNumber') == source.get('カタログ番号')
            and (not source.get('グローバルユニーク番号') or data.get('occurrenceID') == source['グローバルユニーク番号']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output-root', type=Path)
    parser.add_argument('--col-cache', type=Path, required=True)
    parser.add_argument('--public-cache', type=Path, required=True)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--retrieved', required=True)
    parser.add_argument('--model-labels', type=Path, required=True)
    parser.add_argument('--japan-names', type=Path, required=True)
    parser.add_argument('--inat-archive', type=Path)
    parser.add_argument('--inat-metadata', type=Path)
    parser.add_argument('--domestic-records', type=Path)
    parser.add_argument('--snet-verified', type=Path)
    parser.add_argument('--decisions', type=Path)
    args = parser.parse_args()
    date.fromisoformat(args.retrieved)
    root, output = args.root, args.output_root or args.root
    col = load_col(root)
    existing, direct_count, blocked, inputs = col.load_existing(root)
    previous_path = root / 'src/data/japanese-insect-names.json'
    existing.update(read(previous_path)['entries'])
    inputs['src/data/japanese-insect-names.json'] = digest(previous_path)
    direct_count += len(read(previous_path)['entries'])
    previous = read(root / 'docs/japanese-insect-names-audit.json')
    inputs['docs/japanese-insect-names-audit.json'] = digest(root / 'docs/japanese-insect-names-audit.json')
    groups, families = cohort(read(args.model_labels), read(args.japan_names))
    targets = sorted(groups['Insecta'] - existing.keys())
    cache = col.Cache(args.col_cache, args.fetch, args.retrieved)
    public = PublicCache(args.public_cache, args.fetch, args.retrieved)
    metadata = cache.get(col.PREFIX)
    if metadata.get('key') != col.DATASET or metadata.get('license') != 'cc by' or metadata.get('doi') != '10.48580/dgyy9':
        raise ValueError('Unexpected source identity or license')

    def resolve(name):
        if name in blocked:
            return name, None, None, 'previous-source-conflict'
        if len(families[name]) != 1:
            return name, None, None, 'ambiguous-model-family'
        family = next(iter(families[name]))
        row, reason = select_equivalent(col, cache.search(name), name, family)
        route = 'equivalent-col-records'
        if reason == 'no-exact-match':
            url = 'https://api.gbif.org/v2/species/match?' + urllib.parse.urlencode({
                'scientificName': name, 'kingdom': 'Animalia', 'class': 'Insecta',
                'family': family, 'taxonRank': 'SPECIES', 'checklistKey': COL_KEY})
            response = public.get(url)
            identifier = match_identifier(response, name, family)
            if not identifier:
                return name, None, None, 'no-verified-exact-match'
            # GBIF may use a newer release. Never adopt its answer without verifying
            # ID, canonical name, classification and status in our pinned COL release.
            info = public.get('https://api.checklistbank.org' + col.PREFIX + '/taxon/' + urllib.parse.quote(identifier, safe='') + '/info')
            if info.get('httpStatus') == 404:
                return name, None, None, 'absent-from-pinned-col-release'
            if info.get('usage', {}).get('id') != identifier:
                raise ValueError('Mismatched COL response ID')
            row, reason = select_equivalent(col, {'offset': 0, 'total': 1, 'last': True, 'result': [info]}, name, family)
            route = 'canonical-name-match'
        if reason:
            return name, None, None, reason
        info = cache.get(col.PREFIX + '/taxon/' + urllib.parse.quote(col.accepted_usage(row)['id'], safe='') + '/info')
        result, reason, names = choose_equivalent(col, row, info, existing)
        if result:
            entry, proof = result
            return name, entry, dict(proof, stage='col-matching', route=route), None
        return name, None, {'japaneseNames': names}, reason

    entries, proofs, excluded = {}, {}, {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, (name, entry, proof, reason) in enumerate(pool.map(resolve, targets), 1):
            if entry:
                entries[name], proofs[name] = entry, proof
            else:
                excluded[name] = dict(proof or {}, reason=reason)
            if i % 250 == 0:
                print(f'COL verification {i}/{len(targets)}; additions {len(entries)}', flush=True)
    stage_counts = {'col-matching': len(entries)}
    source_files, inat_audit = {}, {}
    sources = {'col': read(previous_path)['source']}
    if bool(args.inat_archive) != bool(args.inat_metadata):
        raise ValueError('Provide both iNaturalist archive and source metadata')
    if args.inat_archive:
        inat_meta = read(args.inat_metadata)
        inat_audit = inat_candidates(args.inat_archive, inat_meta, set(targets), families)
        source_files = {'inaturalist-taxonomy.dwca.zip': digest(args.inat_archive), 'inat-metadata.json': digest(args.inat_metadata)}
        sources['inat'] = {'title': 'iNaturalist Taxonomy', 'version': inat_meta['version'],
                           'sourceUrl': 'https://doi.org/' + inat_meta['versionDoi'],
                           'metadataUrl': 'https://api.checklistbank.org/dataset/139831',
                           'license': 'CC-BY-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
                           'retrieved': args.retrieved,
                           'attribution': 'iNaturalist contributors, iNaturalist Taxonomy (' + inat_meta['version'] + ', CC BY 4.0) をDigiViewerが抽出・加工。'}
        for name, candidate in sorted(inat_audit.items()):
            if name in entries:
                candidate['decision'] = 'already-covered-by-col-matching'
                continue
            reason = candidate['reason']
            if name in blocked:
                reason = 'previous-source-conflict'
            if not reason:
                known = set(previous['excluded'].get(name, {}).get('japaneseNames', []))
                known.update(excluded.get(name, {}).get('japaneseNames', []))
                for row in cache.search(name).get('result', []):
                    cl = {v['rank']: v['name'] for v in row.get('classification', [])}
                    if (col.species_name(row.get('usage', {})) == name and col.species(row.get('usage', {}))
                            and cl.get('class') == 'Insecta' and cl.get('family') in families[name]):
                        known.update(col.labels(row))
                if known - set(candidate['japaneseNames']):
                    reason = 'cross-source-name-conflict'
                    candidate['otherJapaneseNames'] = sorted(known)
            candidate['decision'] = reason or 'added'
            if reason:
                excluded[name] = {'reason': reason, 'japaneseNames': candidate['japaneseNames']}
                continue
            taxon = candidate['records'][0]['taxon']
            entries[name] = {'japaneseName': candidate['japaneseNames'][0], 'sourceUrl': 'https://www.inaturalist.org/taxa/' + taxon['id']}
            proofs[name] = {'stage': 'inat-direct', 'taxonId': taxon['id'], 'scientificName': name,
                            'family': taxon['family'], 'priorExclusion': excluded[name]['reason'],
                            'sourceVersion': inat_meta['version']}
            del excluded[name]
        stage_counts['inat-direct'] = sum(v['stage'] == 'inat-direct' for v in proofs.values())
    domestic_audit, snet_audit = {}, {}
    if args.domestic_records:
        domestic = read(args.domestic_records)
        domestic_audit = domestic_candidates(domestic, families)
        source_files['domestic-records.json'] = digest(args.domestic_records)
        sources['biodic'] = dict(domestic['source'], retrieved=args.retrieved)
        for name, candidate in sorted(domestic_audit.items()):
            if name not in excluded:
                candidate['decision'] = 'already-covered'
                continue
            reason = candidate['reason']
            if name in blocked:
                reason = 'previous-source-conflict'
            known = set(excluded[name].get('japaneseNames', [])) | set(inat_audit.get(name, {}).get('japaneseNames', []))
            if known - set(candidate['japaneseNames']):
                reason = 'domestic-cross-source-conflict'
            candidate['decision'] = reason or 'added'
            if reason:
                continue
            record = candidate['records'][0]
            entries[name] = {'japaneseName': candidate['japaneseNames'][0], 'sourceUrl': record['sourceUrl']}
            proofs[name] = {'stage': 'domestic-list', 'record': record, 'priorExclusion': excluded[name]['reason']}
            del excluded[name]
        stage_counts['domestic-list'] = sum(v['stage'] == 'domestic-list' for v in proofs.values())
    if args.snet_verified:
        snet = read(args.snet_verified)
        snet_audit = snet['results']
        source_files['snet-verified.json'] = digest(args.snet_verified)
        sources['snet'] = {'title': 'S-Net', 'sourceUrl': 'https://www.kahaku.go.jp/kenkyu/s-net/',
                           'license': 'CC-BY-4.0 / CC0-1.0 (selected datasets)', 'retrieved': args.retrieved,
                           'attribution': 'S-Netの提供機関による標本データ（採用分はCC BY 4.0またはCC0）をDigiViewerが抽出・加工。'}
        for name, candidate in sorted(snet_audit.items()):
            if name not in excluded:
                candidate['decision'] = 'already-covered'
                continue
            reason = candidate['reason']
            records = candidate.get('verified', [])
            if not reason and (len(candidate['japaneseNames']) != 1 or len({r['specimen']['機関コード'] for r in records}) < 2):
                raise ValueError('Invalid S-Net verification: ' + name)
            if name in blocked:
                reason = 'previous-source-conflict'
            known = set(excluded[name].get('japaneseNames', [])) | set(inat_audit.get(name, {}).get('japaneseNames', []))
            if known - set(candidate['japaneseNames']):
                reason = 'snet-cross-source-conflict'
            candidate['decision'] = reason or 'added'
            if reason:
                continue
            for r in records:
                if len(families[name]) != 1 or not validate_specimen(name, next(iter(families[name])), candidate['japaneseNames'][0], r):
                    raise ValueError('Invalid S-Net specimen, taxon or license: ' + name)
            licenses = ' / '.join(sorted({'CC BY 4.0' if '/by/' in r['license'] else 'CC0' for r in records}))
            attribution = '出典: ' + '・'.join(sorted({r['specimen']['機関名（日本語）'] for r in records})) + '（S-Net、' + licenses + '）。DigiViewerが抽出・加工。'
            entries[name] = {'japaneseName': candidate['japaneseNames'][0], 'sourceUrl': records[0]['sourceUrl'], 'sourceAttribution': attribution}
            proofs[name] = {'stage': 'snet-specimens', 'records': records, 'priorExclusion': excluded[name]['reason']}
            del excluded[name]
        stage_counts['snet-specimens'] = sum(v['stage'] == 'snet-specimens' for v in proofs.values())
    if args.decisions:
        decisions = read(args.decisions)
        source_files['japanese-name-decisions.json'] = digest(args.decisions)
        for name, decision in sorted(decisions['entries'].items()):
            if name not in excluded:
                raise ValueError('Curated decision no longer refers to an unresolved name: ' + name)
            row, reason = select_equivalent(col, cache.search(name), name, next(iter(families[name])))
            if reason or row['usage']['id'] != decision['colUsageId'] or row['usage']['status'] != 'accepted':
                raise ValueError('Curated taxon identity changed: ' + name)
            old = existing.get(decision['existingScientificName'])
            identifier = 'wikidata:' + decision['sourceUrl'].rsplit('/', 1)[-1]
            if (not old or old['japaneseName'] != decision['japaneseName'] or old['sourceUrl'] != decision['sourceUrl']
                    or decision['linkedIdentifier'] != identifier or identifier not in row['usage'].get('identifier', [])):
                raise ValueError('Curated identifier or Japanese-name evidence changed: ' + name)
            info = cache.get(col.PREFIX + '/taxon/' + decision['colUsageId'] + '/info')
            observed = set(col.labels(row)) | set(col.labels(info)) | set(inat_audit.get(name, {}).get('japaneseNames', []))
            if observed != set(decision['observedJapaneseNames']):
                raise ValueError('Curated conflict set changed: ' + name)
            entries[name] = {'japaneseName': decision['japaneseName'], 'sourceUrl': decision['sourceUrl'], 'aliasSourceUrl': col.PAGE + decision['colUsageId']}
            proofs[name] = {'stage': 'curated-name', 'decision': decision, 'priorExclusion': excluded[name]['reason']}
            del excluded[name]
        stage_counts['curated-name'] = sum(v['stage'] == 'curated-name' for v in proofs.values())
    coverage = {key: {'total': len(names), 'before': len(names & existing.keys()),
                      'after': len(names & (existing.keys() | entries.keys()))} for key, names in sorted(groups.items())}
    result = {'schema': 1, 'retrieved': args.retrieved, 'count': len(entries),
              'sources': sources, 'inputSha256': inputs, 'sourceFileSha256': source_files, 'entries': dict(sorted(entries.items()))}
    report = {'retrieved': args.retrieved, 'targetCount': len(targets), 'additionalCount': len(entries),
              'combinedCount': direct_count + len(entries), 'stages': stage_counts,
              'exclusionCounts': dict(Counter(v['reason'] for v in excluded.values())),
              'modelJapanCoverage': {'counts': coverage, 'labelsSha256': digest(args.model_labels), 'japanSha256': digest(args.japan_names)},
              'entries': dict(sorted(proofs.items())), 'excluded': dict(sorted(excluded.items())),
              'inatCandidates': inat_audit, 'sourceFileSha256': source_files,
              'domesticCandidates': domestic_audit, 'snetCandidates': snet_audit,
              'responseSha256': {**{'https://api.checklistbank.org' + k: v for k, v in sorted(cache.used.items())}, **dict(sorted(public.used.items()))}}
    write(output / 'src/data/japanese-insect-names-extended.json', result)
    write(output / 'docs/japanese-insect-names-extended-audit.json', report)
    print(json.dumps({k: v for k, v in report.items() if k not in {'entries', 'excluded', 'responseSha256', 'inatCandidates', 'domesticCandidates', 'snetCandidates'}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
