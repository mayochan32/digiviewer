"""One offline inference process. It exits after each request to release RAM/GPU memory."""
import json
import sys
import time
from pathlib import Path
import numpy as np
import torch
import open_clip
from torchvision import transforms
from PIL import Image, ImageOps

base = Path(sys.argv[1]).resolve()
assets = json.loads((base / 'assets.json').read_text('utf8'))
torch.set_num_threads(4)

def asset(name):
    target = (base / assets[name]['path']).resolve()
    if not target.is_relative_to(base): raise ValueError('判定データの保存先が不正です。')
    return target

def build_model():
    # No remote model name, code or pickle globals are permitted at inference time.
    model = open_clip.create_model('ViT-L-14', pretrained=None)
    weights = torch.load(asset('open_clip_pytorch_model.bin'), map_location='cpu', weights_only=True)
    model.load_state_dict(weights)
    return model.eval()

preprocess = transforms.Compose([
    transforms.ToTensor(), transforms.Resize((224, 224), antialias=True),
    transforms.Normalize((.48145466, .4578275, .40821073), (.26862954, .26130258, .27577711)),
])

def species_scores(probabilities, indices, size):
    return np.bincount(indices, weights=probabilities, minlength=size)

def top_indices(scores, limit=5):
    count = min(limit, len(scores))
    selected = np.argpartition(scores, -count)[-count:]
    return selected[np.argsort(scores[selected])[::-1]]

def predict(request):
    started = time.perf_counter()
    model = build_model()
    requested = request.get('device', 'auto')
    device = 'cpu'
    if requested != 'cpu':
        if torch.cuda.is_available(): device = 'cuda'
        elif torch.backends.mps.is_available(): device = 'mps'
    with Image.open(request['image']) as source:
        im = ImageOps.exif_transpose(source).convert('RGB')
    w, h = im.size
    cw, ch = max(1, round(w * .6)), max(1, round(h * .6))
    boxes = [(0, 0, w, h)] + [(x, y, x + cw, y + ch) for x, y in [((w-cw)//2, (h-ch)//2), (0, 0), (w-cw, 0), (0, h-ch), (w-cw, h-ch)]]
    warning = None
    def encode(target):
        model.to(target)
        with torch.inference_mode():
            features = []
            for box in boxes:
                value = model.encode_image(preprocess(im.crop(box)).unsqueeze(0).to(target))
                features.append((value / value.norm(dim=-1, keepdim=True)).cpu().numpy()[0])
        return np.stack(features)
    try:
        features = encode(device)
    except RuntimeError:
        if device == 'cpu': raise
        device = 'cpu'
        warning = 'GPUで処理できなかったためCPUで判定しました。'
        features = encode('cpu')
    scale = model.logit_scale.exp().item()
    del model
    # Keep the large class matrix off the GPU so smaller GPUs can also run the encoder.
    embeddings = np.load(asset('txt_emb_species.npy'), mmap_mode='r', allow_pickle=False)
    logits = (features @ embeddings) * scale
    logits -= logits.max(axis=1, keepdims=True)
    probabilities = np.exp(logits)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    labels = json.loads(asset('txt_emb_species.json').read_text('utf8'))
    names, lookup, indices = [], {}, []
    for taxonomy, common in labels:
        name = ' '.join((taxonomy[5] + ' ' + taxonomy[6]).split()[:2])
        if name not in lookup:
            lookup[name] = len(names)
            names.append(name)
        indices.append(lookup[name])
    del labels
    indices = np.asarray(indices)
    geo = json.loads((base / 'japan-names.json').read_text('utf8'))
    use_japan = request.get('japan') is True and geo.get('complete') is True
    records = geo.get('names', {})
    if use_japan:
        priors = np.array([1. if name in records else .1 for name in names], dtype=np.float32)
        probabilities *= priors[indices][None, :]
        probabilities /= probabilities.sum(axis=1, keepdims=True)
    views = [species_scores(row, indices, len(names)) for row in probabilities]
    combined = species_scores(probabilities[0] * .5 + probabilities[1:].sum(axis=0) * .1, indices, len(names))
    view_top = [list(top_indices(scores)) for scores in views]
    candidates = []
    for index in top_indices(combined):
        candidates.append({
            'scientificName': names[index], 'score': float(combined[index]),
            'wholeRank': view_top[0].index(index) + 1 if index in view_top[0] else None,
            'cropSupport': sum(index in top for top in view_top[1:]),
            'japanRecords': records.get(names[index], 0) if geo.get('complete') else None,
        })
    return {'candidates': candidates, 'otherScore': max(0., 1. - sum(c['score'] for c in candidates)),
            'device': device, 'japanApplied': use_japan, 'geographyDate': geo.get('fetched'),
            'seconds': round(time.perf_counter() - started, 2), 'warning': warning,
            'model': 'BioCLIP 2', 'method': 'single-photo-six-views-japan-soft-v1'}

if __name__ == '__main__':
    try:
        if '--check' in sys.argv:
            model = build_model()
            with torch.inference_mode(): model.encode_image(torch.zeros(1, 3, 224, 224))
            print(json.dumps({'ok': True}))
        else:
            request = json.loads(sys.stdin.readline())
            print(json.dumps(predict(request), ensure_ascii=False), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
