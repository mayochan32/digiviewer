import copy
import importlib.util
import io
import csv
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('completion', ROOT / 'scripts/complete-japanese-insect-names.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
col = m.load_col(ROOT)

def row(key='A', name='Example insecta', family='Exampleidae'):
    return {'usage': {'id': key, 'datasetKey': col.DATASET, 'status': 'accepted',
                     'name': {'scientificName': name, 'rank': 'species', 'code': 'zoological', 'type': 'scientific'}},
            'classification': [{'rank':'kingdom','name':'Animalia'},{'rank':'class','name':'Insecta'},{'rank':'family','name':family}],
            'vernacularNames': [{'language':'jpn','name':'テストムシ'}]}

def response(*rows):return {'offset':0,'total':len(rows),'last':True,'result':list(rows)}

class CompletionTest(unittest.TestCase):
    def test_domestic_pdf_rows_do_not_promote_subspecies_or_ambiguous_names(self):
        spec = importlib.util.spec_from_file_location('domestic', ROOT / 'scripts/extract-domestic-insect-names.py')
        domestic = importlib.util.module_from_spec(spec); spec.loader.exec_module(domestic)
        self.assertEqual(domestic.parse_row('1234 Example insecta テストムシ A ○')['japaneseName'], 'テストムシ')
        self.assertIsNone(domestic.parse_row('1234 Example insecta minor アシュ A ○'))
        self.assertIsNone(domestic.parse_row('1234 Example sp. テストムシ A ○'))
        document = {'source': {'license': 'PDL-1.0', 'version': '1997'}, 'records': [
            {'scientificName': 'Example insecta', 'japaneseName': 'テストムシ', 'family': 'Otheridae'}]}
        self.assertEqual(m.domestic_candidates(document, {'Example insecta': {'Exampleidae'}})['Example insecta']['reason'], 'domestic-different-family')
        document['records'].append(dict(document['records'][0], japaneseName='ベツノムシ'))
        self.assertEqual(m.domestic_candidates(document, {'Example insecta': {'Exampleidae'}})['Example insecta']['reason'], 'domestic-conflicting-names')

    def test_specimens_require_same_identity_species_classification_and_permitted_license(self):
        license_url = 'https://creativecommons.org/licenses/by/4.0/legalcode'
        good = {'license': license_url, 'datasetLicense': license_url,
                'specimen': {'管理ID': '1', '学名': 'Example insecta (Author, 1900)', '和名': 'テストムシ', '分類群ランク': 'species',
                             '機関コード': 'MUSEUM', 'コレクションコード': 'Insects', 'カタログ番号': '123', 'グローバルユニーク番号': 'uuid'},
                'gbif': {'class': 'Insecta', 'family': 'Exampleidae', 'species': 'Example insecta', 'taxonRank': 'SPECIES',
                         'taxonomicStatus': 'ACCEPTED', 'vernacularName': 'テストムシ', 'institutionCode': 'MUSEUM',
                         'collectionCode': 'Insects', 'catalogNumber': '123', 'occurrenceID': 'uuid', 'issues': []}}
        self.assertTrue(m.validate_specimen('Example insecta', 'Exampleidae', 'テストムシ', good))
        for change in [lambda d: d.update(datasetLicense='CC-BY-NC'), lambda d: d['specimen'].update(学名='Example insecta minor'),
                       lambda d: d['specimen'].update(分類群ランク='subspecies'), lambda d: d['specimen'].update(機関コード=''),
                       lambda d: d['gbif'].update(occurrenceID='different'), lambda d: d['gbif'].update(taxonRank='SUBSPECIES'),
                       lambda d: d['gbif'].update(family='Violaceae'), lambda d: d['gbif'].update(issues=['TAXON_MATCH_FUZZY'])]:
            bad = copy.deepcopy(good); change(bad)
            self.assertFalse(m.validate_specimen('Example insecta', 'Exampleidae', 'テストムシ', bad))

    def test_subgenus_and_same_species_records_are_resolved(self):
        original = row(name='Example (Subgenus) insecta')
        selected, error = m.select_equivalent(col,response(original),'Example insecta','Exampleidae')
        self.assertIsNone(error)
        self.assertEqual(col.species_name(selected['usage']),'Example insecta')
        duplicate = copy.deepcopy(original)
        selected,error=m.select_equivalent(col,response(original,duplicate),'Example insecta','Exampleidae')
        self.assertIsNone(error)
        self.assertEqual(m.choose_equivalent(col,selected,original,{})[0][0]['japaneseName'],'テストムシ')

    def test_other_family_homonym_does_not_block_but_competing_species_does(self):
        self.assertIsNone(m.select_equivalent(col,response(row(),row('B',family='Otheridae')),'Example insecta','Exampleidae')[1])
        self.assertEqual(m.select_equivalent(col,response(row(),row('B')),'Example insecta','Exampleidae')[1],'different-accepted-species')
        bad=row('B');bad['issues']=['homotypic consolidation unresolved']
        self.assertIsNotNone(m.select_equivalent(col,response(row(),bad),'Example insecta','Exampleidae')[1])

    def test_conflicting_equivalent_names_are_not_silently_selected(self):
        good=row();other=row('OLD');other['usage'].update(status='synonym',parentId='A',accepted=good['usage'])
        other['vernacularNames']=[{'language':'jpn','name':'ベツノムシ'}]
        selected,error=m.select_equivalent(col,response(good,other),'Example insecta','Exampleidae')
        self.assertIsNone(error)
        self.assertEqual(m.choose_equivalent(col,selected,good,{})[1],'conflicting-japanese-names')

    def test_incomplete_search_wrong_species_and_subspecies_fail_closed(self):
        with self.assertRaises(ValueError):m.select_equivalent(col,dict(response(row()),last=False),'Example insecta','Exampleidae')
        self.assertIsNotNone(m.select_equivalent(col,response(row()),'Example insectus','Exampleidae')[1])
        bad=row(name='Example insecta minor');bad['usage']['name']['rank']='subspecies'
        self.assertIsNotNone(m.select_equivalent(col,response(bad),'Example insecta','Exampleidae')[1])

    def test_match_api_is_only_used_for_exact_species_in_right_classification(self):
        good={'usage':{'key':'A','canonicalName':'Example insecta','rank':'SPECIES','type':'SCIENTIFIC','code':'ZOOLOGICAL','status':'ACCEPTED'},
              'diagnostics':{'matchType':'EXACT'},'synonym':False,
              'classification':[{'rank':'KINGDOM','name':'Animalia'},{'rank':'CLASS','name':'Insecta'},{'rank':'FAMILY','name':'Exampleidae'}]}
        self.assertEqual(m.match_identifier(good,'Example insecta','Exampleidae'),'A')
        for change in [lambda d:d['diagnostics'].update(matchType='FUZZY'),lambda d:d['usage'].update(rank='GENUS'),
                       lambda d:d['usage'].update(canonicalName='Example insectus'),lambda d:d.update(synonym=True),
                       lambda d:d['classification'][2].update(name='Otheridae')]:
            bad=copy.deepcopy(good);change(bad);self.assertIsNone(m.match_identifier(bad,'Example insecta','Exampleidae'))

    def test_offline_missing_response_is_an_error_and_404_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            cache=m.PublicCache(Path(directory),False,'2026-10-12')
            with self.assertRaisesRegex(ValueError,'Missing'):cache.get('https://api.gbif.org/missing')
            with self.assertRaisesRegex(ValueError,'host'):cache.get('https://example.org/missing')

    def test_inat_requires_matching_version_rank_family_and_one_name(self):
        metadata={'key':139831,'title':'iNaturalist Taxonomy','license':'cc by','versionDoi':'10.48580/d7r9s.v56','version':'2026-10-01'}
        fields=['id','scientificName','kingdom','class','family','taxonRank','genus','specificEpithet','infraspecificEpithet']
        taxa=[['1','Example insecta','Animalia','Insecta','Exampleidae','species','Example','insecta',''],
              ['2','Other insecta','Animalia','Insecta','Otheridae','species','Other','insecta',''],
              ['3','Example minor','Animalia','Insecta','Exampleidae','subspecies','Example','minor','minor'],
              ['4','Conflict insecta','Animalia','Insecta','Exampleidae','species','Conflict','insecta','']]
        names=[['1','テストムシ','ja'],['2','ホカノムシ','ja'],['3','アシュ','ja'],['4','ムシイチ','ja'],['4','ムシニ','ja']]
        def data(headers,rows):
            f=io.StringIO();w=csv.writer(f);w.writerow(headers);w.writerows(rows);return f.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'inat.zip'
            with zipfile.ZipFile(path,'w') as z:
                z.writestr('eml.xml','<eml><dataset><title>iNaturalist Taxonomy</title><pubDate>2026-10-01</pubDate></dataset></eml>')
                z.writestr('taxa.csv',data(fields,taxa));z.writestr('VernacularNames-japanese.csv',data(['id','vernacularName','language'],names))
            targets={r[1] for r in taxa};families={n:{'Exampleidae'} for n in targets}
            actual=m.inat_candidates(path,metadata,targets,families)
            self.assertIsNone(actual['Example insecta']['reason'])
            self.assertEqual(actual['Other insecta']['reason'],'inat-different-family')
            self.assertNotIn('Example minor',actual)
            self.assertEqual(actual['Conflict insecta']['reason'],'inat-conflicting-japanese-names')
            with self.assertRaisesRegex(ValueError,'versions'):m.inat_candidates(path,dict(metadata,version='2026-08-01'),targets,families)
            with self.assertRaisesRegex(ValueError,'license'):m.inat_candidates(path,dict(metadata,license='other'),targets,families)

if __name__=='__main__':unittest.main()
