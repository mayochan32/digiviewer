"""Regression tests for rejecting ambiguous or incorrectly ranked name records."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[1] / 'scripts/expand-japanese-species-names.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NamesBuilderTest(unittest.TestCase):
    def test_rejects_non_species_and_missing_japanese_names(self):
        self.assertTrue(builder.eligible('Coccinella ainu', 'アイヌテントウ'))
        for name, japanese in [
            ('Coccinella', 'テントウムシ属'),
            ('Parnara guttata guttata', 'イチモンジセセリ'),
            ('Coccinella sp.', 'テントウムシ'), ('Coccinella sp', 'テントウムシ'),
            ('Coccinella cf', 'テントウムシ'), ('Coccinella ainu', 'Coccinella ainu'),
            ('Coccinella ainu', 'テントウムシ科'),
            ('Coccinella ainu (Lewis)', 'アイヌテントウ'),
            ('Coccinella ainu', None), (None, 'アイヌテントウ'),
        ]:
            self.assertFalse(builder.eligible(name, japanese), (name, japanese))

    def test_conflicts_preserve_existing_names_and_exclude_new_ambiguity(self):
        base = {'Coccinella septempunctata': ['ナナホシテントウ', 'Q1']}
        records = [
            ('Coccinella septempunctata', 'ベツノナマエ', 'nilim-r07', '1', 'Insecta'),
            ('Coccinella ainu', 'アイヌテントウ', 'wikidata', 'Q2', ''),
            ('Coccinella ainu', 'アイヌテントウ', 'nilim-r07', '76624', 'Insecta'),
            ('Example conflict', 'ナマエイチ', 'wikidata', 'Q3', ''),
            ('Example conflict', 'ナマエニ', 'nilim-r07', '2', 'Insecta'),
            ('Example internal', 'ナマエイチ', 'nilim-r07', '3', 'Insecta'),
            ('Example internal', 'ナマエニ', 'nilim-r07', '4', 'Insecta'),
        ]
        entries, report = builder.merge(base, records)
        self.assertEqual(entries, {'Coccinella ainu': ['アイヌテントウ', 'nilim-r07', '76624']})
        self.assertEqual(report['existingNamesPreserved']['Coccinella septempunctata']['retained'], 'ナナホシテントウ')
        self.assertEqual(set(report['newNamesExcluded']), {'Example conflict', 'Example internal'})
        self.assertEqual(builder.merge(base, list(reversed(records))), (entries, report))

    def test_reads_documented_workbook_columns_without_promoting_subspecies(self):
        from openpyxl import Workbook
        book = Workbook(); sheet = book.active; sheet.title = '目録リスト'
        header = [''] * 44
        for column, value in {8: '綱', 24: '種コード', 25: '学名', 26: '種和名'}.items():
            header[column] = value
        sheet.append(header)
        for code, scientific, japanese in [(76624, 'Coccinella ainu', 'アイヌテントウ'), (59527, 'Parnara guttata guttata', 'イチモンジセセリ'), (123, 'Example latin', 'Example latin')]:
            row = [''] * 44
            row[8] = 'Insecta'; row[24:27] = [code, scientific, japanese]; row[33] = 1
            sheet.append(row)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'list.xlsx'; book.save(path)
            self.assertEqual(builder.read_nilim(path), [('Coccinella ainu', 'アイヌテントウ', 'nilim-r07', '76624', 'Insecta')])
            sheet.cell(1, 26, '違う列'); book.save(path)
            with self.assertRaises(ValueError): builder.read_nilim(path)


if __name__ == '__main__':
    unittest.main()
