"""Build a conservative S-Net supplement from public specimen records.

Offline by default. --fetch permits read-only public searches and CSV exports.
Require complete exports, one name, two institutions and matching GBIF records
whose dataset licenses allow redistribution. No photographs are sent anywhere.
"""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date
import importlib.util
import io
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

SPEC = importlib.util.spec_from_file_location('completion', Path(__file__).with_name('complete-japanese-insect-names.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
FIELDS = ['管理ID', 'データセット管理番号', 'グローバルユニーク番号', '機関コード', '機関名（日本語）',
          'コレクションコード', 'カタログ番号', '学名', '和名', '科名（学名）', '分類群ランク', '亜種以下のタクソン']
GBIF_FIELDS = ['key', 'institutionCode', 'collectionCode', 'catalogNumber', 'occurrenceID', 'class',
               'family', 'species', 'taxonRank', 'taxonomicStatus', 'vernacularName', 'issues']


def download(path, url, fetch, export=False):
    if not path.exists():
        if not fetch:
            raise ValueError('Missing cached S-Net response: ' + str(path))
        request = urllib.request.Request(url, data=b'' if export else None,
                                         headers={'User-Agent': 'DigiViewer/0.6.2 (Japanese-name dictionary)'})
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read()
        path.write_bytes(content)
        time.sleep(.5)
    return path.read_bytes()


def source_rows(target, directory, fetch):
    name = target['name']
    if not re.fullmatch(r'[A-Z][a-z]+ [a-z][a-z-]+', name):
        raise ValueError('Invalid target species name')
    stem = name.replace(' ', '_')
    params = {'secIdx': 0, 'cls': 'top', 'pn': 1, 'chkCls': 'collect11',
              'c2_f': name, 'c2_a': 1, 'c2_l': 1, 'dispnum': 25}
    query = urllib.parse.urlencode(params)
    url = 'https://science-net.kahaku.go.jp/search/list?' + query
    listing = directory / (stem + '.html')
    text = download(listing, url, fetch).decode('utf8')
    matched = re.search(r'id="totalCount" value="(\d+)"', text)
    proof = {'name': name, 'listUrl': url, 'listSha256': m.digest(listing)}
    if not matched:
        if any(v in text for v in ['該当するデータはありません', '0 件', '0件']):
            return [], dict(proof, status='empty', count=0)
        raise ValueError('Unrecognized S-Net listing: ' + name)
    count = int(matched[1])
    if count == 0 or count > 5000:
        return [], dict(proof, status='empty' if not count else 'too-many', count=count)
    export = 'https://science-net.kahaku.go.jp/search/rest/download?' + query + '&fileType=CSV&charCode=UTF8'
    table = directory / (stem + '.csv')
    rows = list(csv.DictReader(io.StringIO(download(table, export, fetch, True).decode('utf-8-sig'))))
    if len(rows) != count or not rows or not set(FIELDS).issubset(rows[0]):
        raise ValueError('Incomplete or unexpected S-Net CSV: ' + name)
    return rows, dict(proof, status='complete', count=count, exportUrl=export, csvSha256=m.digest(table))


def candidates(name, rows):
    selected = [{k: r[k] for k in FIELDS} for r in rows if m.exact_specimen_name(name, r)]
    return {'japaneseNames': sorted({r['和名'] for r in selected}),
            'institutions': sorted({r['機関コード'] for r in selected if r['機関コード']}), 'records': selected}


def verify(name, family, candidate, cache):
    labels = candidate['japaneseNames']
    if len(labels) != 1:
        return {'reason': 'conflicting-specimen-names' if labels else 'no-exact-specimen-name', 'japaneseNames': labels}
    if len(candidate['institutions']) < 2:
        return {'reason': 'only-one-institution', 'japaneseNames': labels}
    by_institution = defaultdict(list)
    for row in candidate['records']:
        by_institution[row['機関コード']].append(row)
    institutions = sorted(by_institution, key=lambda k: (not any(r['科名（学名）'] == family for r in by_institution[k]), k))
    verified, attempted = [], []
    for institution in institutions[:5]:
        records = sorted(by_institution[institution], key=lambda r: (r['科名（学名）'] != family, r['管理ID']))
        for row in records[:2]:
            if not row['機関コード'] or not row['カタログ番号']:
                continue
            url = 'https://api.gbif.org/v1/occurrence/search?' + urllib.parse.urlencode({
                'institutionCode': row['機関コード'], 'collectionCode': row['コレクションコード'],
                'catalogNumber': row['カタログ番号'], 'limit': 20})
            data = cache.get(url)
            matches = [r for r in data.get('results', []) if r.get('institutionCode') == row['機関コード']
                       and r.get('collectionCode') == row['コレクションコード'] and r.get('catalogNumber') == row['カタログ番号']]
            attempted.append({'recordId': row['管理ID'], 'url': url, 'matches': len(matches)})
            if len(matches) != 1 or not data.get('endOfRecords'):
                continue
            r = matches[0]
            record = {'specimen': row, 'license': r.get('license'), 'datasetLicense': r.get('license'),
                      'gbif': {k: r.get(k) for k in GBIF_FIELDS}}
            if not m.validate_specimen(name, family, labels[0], record):
                continue
            dataset = cache.get('https://api.gbif.org/v1/dataset/' + r['datasetKey'])
            record['datasetLicense'] = dataset.get('license')
            if not m.validate_specimen(name, family, labels[0], record):
                continue
            record.update(occurrenceKey=r['key'], datasetKey=r['datasetKey'], datasetTitle=dataset['title'],
                          scientificName=r['scientificName'], taxonKey=r.get('taxonKey'),
                          occurrenceUrl='https://www.gbif.org/occurrence/' + str(r['key']),
                          sourceUrl='https://science-net.kahaku.go.jp/specimen/' + row['管理ID'])
            verified.append(record)
            break
        if len(verified) >= 2:
            break
    return {'reason': None if len(verified) >= 2 else 'fewer-than-two-verified-institutions',
            'japaneseNames': labels, 'verified': verified, 'attempted': attempted}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--retrieved', required=True)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    date.fromisoformat(args.retrieved)
    targets = m.read(args.targets)
    if len({t['name'] for t in targets}) != len(targets):
        raise ValueError('Duplicate target species')
    directory = args.cache / 'snet'
    directory.mkdir(parents=True, exist_ok=True)
    cache = m.PublicCache(args.cache / 'snet-gbif-cache', args.fetch, args.retrieved)
    def process(target):
        rows, audit = source_rows(target, directory, args.fetch)
        candidate = candidates(target['name'], rows)
        result = verify(target['name'], target['family'], candidate, cache)
        return target['name'], result, audit
    results, downloads = {}, []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for name, result, audit in pool.map(process, sorted(targets, key=lambda t: t['name'])):
            results[name] = result
            downloads.append(audit)
            print(name, result['reason'] or 'verified', flush=True)
    m.write(args.output, {'retrieved': args.retrieved, 'targetsSha256': m.digest(args.targets),
                          'downloads': downloads, 'results': results, 'responseSha256': dict(sorted(cache.used.items()))})


if __name__ == '__main__':
    main()
