"""Setup only: download public model and range metadata; never receives a photo."""
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from huggingface_hub import HfApi, hf_hub_download

base = Path(sys.argv[1]).resolve()

def progress(message):
    print(json.dumps({'progress': message}, ensure_ascii=False), flush=True)

assets = {}
api = HfApi()
for repo, kind, revision, filenames in [
    ('imageomics/bioclip-2', 'model', '2957b322090f9cb17ae72c71981c7218a28d81e0', ['open_clip_pytorch_model.bin']),
    ('imageomics/TreeOfLife-200M', 'dataset', 'a8f38b4388579862c56ae57d6f094c2ac0e92e12', ['embeddings/txt_emb_species.json', 'embeddings/txt_emb_species.npy']),
]:
    info = api.repo_info(repo, repo_type=kind, revision=revision, files_metadata=True)
    for filename in filenames:
        progress('判定データを取得・検証しています: ' + Path(filename).name)
        file = Path(hf_hub_download(repo, filename, repo_type=kind, revision=revision))
        metadata = next(f for f in info.siblings if f.rfilename == filename)
        if metadata.size != file.stat().st_size:
            raise RuntimeError('判定データのサイズが一致しません。')
        # LFS files carry a SHA-256; Git-managed small files use a blob hash.
        digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
        if metadata.lfs and digest != metadata.lfs.sha256:
            raise RuntimeError('判定データのハッシュが一致しません。')
        if not metadata.lfs:
            h = hashlib.sha1(('blob ' + str(metadata.size) + '\0').encode())
            with file.open('rb') as stream:
                while chunk := stream.read(1024 * 1024): h.update(chunk)
            if h.hexdigest() != metadata.blob_id: raise RuntimeError('判定データの検証に失敗しました。')
        assets[Path(filename).name] = {'path': str(file.relative_to(base)), 'sha256': digest, 'revision': revision}

geo_path = base / 'japan-names.json'
# Keep a complete previously downloaded snapshot on retry.
geo = json.loads(geo_path.read_text('utf8')) if geo_path.exists() else {}
if not geo.get('complete'):
    try:
        names, urls = {}, []
        for offset in range(0, 300000, 10000):
            progress('日本の生息記録を取得しています: ' + str(offset) + '件〜')
            query = urllib.parse.urlencode({'country': 'JP', 'occurrenceStatus': 'PRESENT', 'limit': 0, 'facet': 'scientificName', 'facetLimit': 10000, 'facetOffset': offset})
            url = 'https://api.gbif.org/v1/occurrence/search?' + query
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=90) as stream: data = json.load(stream)
                    break
                except Exception:
                    if attempt == 2: raise
                    time.sleep(2)
            urls.append(url)
            counts = data['facets'][0]['counts']
            for entry in counts:
                m = re.match(r'^([A-Z][a-z]+)\s+(?:\([A-Z][a-z]+\)\s+)?([a-z][a-z-]+)(?=\s|$)', entry['name'])
                if m and m[2] not in ['sp', 'spp', 'cf', 'aff']:
                    name = m[1] + ' ' + m[2]
                    names[name] = names.get(name, 0) + entry['count']
            if len(counts) < 10000: break
        else: raise RuntimeError('生息記録の取得上限に達しました。')
        geo = {'complete': True, 'fetched': str(date.today()), 'source': 'GBIF occurrence scientificName facets', 'urls': urls, 'names': names}
        geo_path.write_text(json.dumps(geo, ensure_ascii=False), encoding='utf8')
    except Exception as error:
        # Incomplete coverage must not penalize species missing from a partial list.
        progress('日本の記録を取得できませんでした。地域補正なしで利用できます。再導入で再取得できます。')
        geo = {'complete': False, 'names': {}}
        geo_path.write_text(json.dumps(geo), encoding='utf8')
assets['geography'] = {'complete': geo.get('complete', False), 'fetched': geo.get('fetched')}
(base / 'assets.json').write_text(json.dumps(assets, indent=2), encoding='utf8')
