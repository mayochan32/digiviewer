"""Rebuild the bundled CC0 Wikidata snapshot; never run on an end-user PC."""
import argparse
from collections import defaultdict
from datetime import date
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

QUERY = '''SELECT ?taxon ?name ?label WHERE {
  ?article schema:isPartOf <https://ja.wikipedia.org/> .
  hint:Prior hint:runFirst true .
  ?article schema:about ?taxon .
  ?taxon wdt:P105 wd:Q7432; wdt:P225 ?name; rdfs:label ?label .
  FILTER(LANG(?label) = "ja")
}'''

def snapshot(data):
    grouped = defaultdict(lambda: defaultdict(set))
    for row in data['results']['bindings']:
        scientific, japanese = row['name']['value'], row['label']['value']
        entity = row['taxon']['value'].rsplit('/', 1)[-1]
        # Exact binomials only: do not borrow a genus/subspecies label.
        if not re.fullmatch(r'[A-Z][a-z]+ [a-z][a-z-]+', scientific):
            continue
        if not re.search(r'[ァ-ヺ]', japanese) or not re.fullmatch(r'Q[1-9][0-9]*', entity):
            continue
        grouped[scientific][japanese].add(entity)
    entries, conflicts = {}, {}
    for scientific, labels in sorted(grouped.items()):
        if len(labels) != 1:
            conflicts[scientific] = sorted(labels)
            continue
        japanese, entities = next(iter(labels.items()))
        entries[scientific] = [japanese, sorted(entities, key=lambda value: int(value[1:]))[0]]
    if len(entries) < 8000:
        raise ValueError('Incomplete or unexpectedly small snapshot; existing file was not changed')
    return {
        'source': 'Wikidata', 'license': 'CC0-1.0', 'retrieved': date.today().isoformat(),
        'query': QUERY, 'count': len(entries), 'conflicts': conflicts, 'entries': entries,
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='Previously downloaded complete SPARQL JSON response')
    args = parser.parse_args()
    if args.input:
        data = json.loads(args.input.read_text())
    else:
        def fetch(query):
            url = 'https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': query, 'format': 'json'})
            request = urllib.request.Request(url, headers={
                'User-Agent': 'DigiViewer (https://github.com/mayochan32/digiviewer; Japanese species names)',
                'Accept': 'application/sparql-results+json',
            })
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.load(response)
        # Splitting the rank join avoids a timeout on the public query service.
        data = fetch(QUERY.replace('wdt:P105 wd:Q7432; ', ''))
        rows = data['results']['bindings']
        ids = sorted({row['taxon']['value'].rsplit('/', 1)[-1] for row in rows})
        if not all(re.fullmatch(r'Q[1-9][0-9]*', item) for item in ids):
            raise ValueError('Unexpected taxon identifier')
        accepted = set()
        for offset in range(0, len(ids), 300):
            values = ' '.join('wd:' + item for item in ids[offset:offset + 300])
            ranks = fetch('SELECT DISTINCT ?taxon WHERE { VALUES ?taxon { ' + values + ' } ?taxon wdt:P105 wd:Q7432 . }')
            accepted.update(row['taxon']['value'] for row in ranks['results']['bindings'])
            print('Checked taxon ranks:', min(offset + 300, len(ids)), '/', len(ids), flush=True)
        data['results']['bindings'] = [row for row in rows if row['taxon']['value'] in accepted]
    result = snapshot(data)
    output = Path(__file__).resolve().parent.parent / 'src/data/japanese-species-names.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f"Saved {result['count']} names; excluded {len(result['conflicts'])} conflicting binomials")
