import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('insect_builder', Path(__file__).resolve().parents[1] / 'scripts/expand-japanese-insect-names.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def usage(name='Example insecta', key='A1', status='accepted', rank='species'):
    return {'id': key, 'datasetKey': m.DATASET, 'status': status,
            'name': {'scientificName': name, 'rank': rank, 'code': 'zoological', 'type': 'scientific'}}


def row():
    return {'usage': usage(), 'classification': [{'rank': 'kingdom', 'name': 'Animalia'},
            {'rank': 'class', 'name': 'Insecta'}, {'rank': 'family', 'name': 'Exampleidae'}],
            'vernacularNames': [{'language': 'jpn', 'name': 'テストムシ'}]}


def search(record):
    return {'offset': 0, 'total': 1, 'last': True, 'result': [record]}


class InsectBuilderTest(unittest.TestCase):
    def test_requires_exact_unambiguous_species_and_classification(self):
        good = row()
        self.assertIsNone(m.select_exact(search(good), 'Example insecta', 'Exampleidae')[1])
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            m.select_exact(dict(search(good), last=False), 'Example insecta', 'Exampleidae')
        self.assertIsNotNone(m.select_exact(dict(search(good), total=2, result=[good, good]), 'Example insecta', 'Exampleidae')[1])
        self.assertIsNotNone(m.select_exact(search(good), 'Example insectus', 'Exampleidae')[1])
        for change in [lambda r: r['usage']['name'].update(rank='subspecies'),
                       lambda r: r['classification'][1].update(name='Aves'),
                       lambda r: r['usage'].update(status='misapplied'),
                       lambda r: r.update(issues=['homotypic consolidation unresolved'])]:
            bad = copy.deepcopy(good)
            change(bad)
            self.assertIsNotNone(m.select_exact(search(bad), 'Example insecta', 'Exampleidae')[1])
        self.assertIsNotNone(m.select_exact(search(good), 'Example insecta', 'Anotheridae')[1])

    def test_vernacular_must_be_japanese_and_katakana(self):
        good = row()
        good['vernacularNames'] += [{'language': 'zho', 'name': 'ベツノムシ'}, {'language': 'jpn', 'name': 'Test insect'}, {'language': 'jpn', 'name': 'テストムシ本土亜種'}]
        self.assertEqual(m.labels(good), ['テストムシ'])
        self.assertEqual(m.choose(good, None, {})[0][0]['japaneseName'], 'テストムシ')

    def test_synonym_must_resolve_to_an_accepted_species(self):
        old = row()
        old['usage'].update(status='synonym', parentId='B2', accepted=usage('Modern insecta', 'B2'))
        existing = {'Modern insecta': {'japaneseName': 'テストムシ', 'sourceUrl': 'https://example.org/source'}}
        self.assertIsNone(m.select_exact(search(old), 'Example insecta', 'Exampleidae')[1])
        self.assertEqual(m.choose(old, None, existing)[0][0]['aliasSourceUrl'], m.PAGE + 'A1')
        old['usage']['accepted']['name']['rank'] = 'subspecies'
        self.assertIsNotNone(m.select_exact(search(old), 'Example insecta', 'Exampleidae')[1])

    def test_homotypic_mapping_rejects_subspecies_heterotypic_and_conflicts(self):
        current = row()
        current['vernacularNames'] = []
        synonym = usage('Old insecta', 'B2', 'synonym')
        synonym['parentId'] = 'A1'
        info = {'usage': usage(), 'synonyms': {'homotypic': [synonym]}}
        existing = {'Old insecta': {'japaneseName': 'テストムシ', 'sourceUrl': 'https://example.org/old'}}
        self.assertEqual(m.choose(current, info, existing)[0][1]['method'], 'homotypic-synonym')
        changed = copy.deepcopy(info)
        changed['synonyms']['heterotypic'] = changed['synonyms'].pop('homotypic')
        self.assertEqual(m.choose(current, changed, existing)[1], 'no-japanese-name')
        changed = copy.deepcopy(info)
        changed['synonyms']['homotypic'][0]['name']['rank'] = 'subspecies'
        self.assertEqual(m.choose(current, changed, existing)[1], 'no-japanese-name')
        changed = copy.deepcopy(info)
        changed['vernacularNames'] = [{'language': 'jpn', 'name': 'ベツノムシ'}]
        self.assertEqual(m.choose(current, changed, existing)[1], 'conflicting-japanese-names')
        changed = copy.deepcopy(info)
        changed['usage']['id'] = 'WRONG'
        self.assertEqual(m.choose(current, changed, existing)[1], 'mismatched-taxon-info')

    def test_explicit_species_with_subgenus_does_not_promote_subspecies(self):
        old = row()
        old['usage'].update(status='synonym', parentId='B2', accepted=usage('Example (Subgenus) insecta', 'B2'))
        self.assertIsNone(m.select_exact(search(old), 'Example insecta', 'Exampleidae')[1])
        info = {'usage': usage('Example (Subgenus) insecta', 'B2'), 'vernacularNames': old['vernacularNames']}
        self.assertEqual(m.choose(old, info, {})[0][0]['japaneseName'], 'テストムシ')
        info['usage']['name'].update(scientificName='Example insecta minor', rank='subspecies')
        self.assertEqual(m.choose(old, info, {})[1], 'mismatched-taxon-info')

    def test_offline_build_does_not_silently_skip_missing_responses(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = m.Cache(Path(folder), False, '2026-10-12')
            with self.assertRaisesRegex(ValueError, 'Missing cached response'):
                cache.search('Example insecta')


if __name__ == '__main__':
    unittest.main()
