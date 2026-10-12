"""Extract only explicit binomial rows from five Ministry of Environment lists.

Developer tool: pdfplumber is used only to read source PDFs, never by DigiViewer.
"""
import argparse, hashlib, json, re, unicodedata
from pathlib import Path
FILES = {'05_to.pdf': 'Odonata', '06_cho.pdf': 'Lepidoptera', '07_se.pdf': 'Hemiptera', '08_ga.pdf': 'Lepidoptera', '09_ko.pdf': 'Coleoptera'}

def parse_row(line):
    line = unicodedata.normalize('NFKC', line)
    m = re.fullmatch(r'(?P<code>\d{4})\s+(?P<scientificName>[A-Z][a-z]+ [a-z][a-z-]+)\s+(?P<japaneseName>[ァ-ヺー・]+)(?:\s+[A-Za-z○△×−―－*＊()\s]+)?', line.strip())
    return m.groupdict() if m else None

def extract(directory):
    import pdfplumber
    records, counts, hashes = [], {}, {}
    for filename, order in FILES.items():
        path = directory / filename
        hashes[filename] = hashlib.sha256(path.read_bytes()).hexdigest()
        count, family = 0, None
        with pdfplumber.open(path) as doc:
            for page, obj in enumerate(doc.pages, 1):
                text = obj.extract_text(x_tolerance=2) or ''
                if '対象種一覧' not in text or '学名' not in text or '和名' not in text:
                    raise ValueError('Unexpected PDF structure: ' + filename + ':' + str(page))
                for raw in text.splitlines():
                    family_match = re.match(r'^([A-Z]+IDAE)(?:\(([A-Za-z]+idae)\))?\s', raw)
                    if family_match:
                        family = (family_match[2] or family_match[1]).capitalize()
                    row = parse_row(raw)
                    if row:
                        if not family:raise ValueError('Missing family header')
                        records.append(dict(row, file=filename, page=page, family=family, order=order, originalRow=raw,
                                            sourceUrl='https://www.biodic.go.jp/kiso/do05/' + filename + '#page=' + str(page)))
                        count += 1
        counts[filename] = count
        if not count:raise ValueError('No species rows found: '+filename)
    return {'source': {'title': '環境省生物多様性センター「種の多様性調査（専門家調査）対象種一覧」',
                       'version': '1997', 'sourceUrl': 'https://www.biodic.go.jp/kiso/do05/index.html',
                       'license': 'PDL-1.0', 'licenseUrl': 'https://www.biodic.go.jp/copyright/terms_of_service.html',
                       'attribution': '環境省生物多様性センター「種の多様性調査（専門家調査）対象種一覧」（1997、PDL1.0）をDigiViewerが抽出・加工。'},
            'sourceSha256': hashes, 'rowCounts': counts, 'records': records}
if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--directory',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();result=extract(args.directory);args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result['rowCounts']))
