"""O look do Sabi é resolvido no servidor e guardado em meta."""
import ast
import sqlite3
import unittest
from datetime import date
from pathlib import Path


SOURCE_PATH = Path(__file__).resolve().parent.parent / 'portal_server.py'
TREE = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), filename=str(SOURCE_PATH))


def load_sabi():
    names = {'SABI_META_KEY', 'SABI_LOOKS', 'sabi_look', 'sabi_effective_look', 'sabi_payload'}
    body = []
    for item in TREE.body:
        if isinstance(item, ast.FunctionDef) and item.name in names:
            body.append(item)
        elif isinstance(item, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in names for target in item.targets
        ):
            body.append(item)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace = {'date': date}
    exec(compile(module, str(SOURCE_PATH), 'exec'), namespace)
    return namespace


class SabiLookTest(unittest.TestCase):
    def setUp(self):
        self.sabi = load_sabi()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def store(self, value):
        self.db.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ('sabi_look', value))

    def test_auto_follows_the_calendar(self):
        resolve = self.sabi['sabi_effective_look']
        self.assertEqual(resolve('auto', date(2026, 12, 5)), 'natal')
        self.assertEqual(resolve('auto', date(2026, 6, 13)), 'junina')
        self.assertEqual(resolve('auto', date(2026, 1, 20)), 'verao')
        self.assertEqual(resolve('auto', date(2026, 2, 20)), 'verao')
        self.assertEqual(resolve('auto', date(2026, 3, 2)), 'verao')
        self.assertEqual(resolve('auto', date(2026, 7, 10)), 'inverno')
        self.assertEqual(resolve('auto', date(2026, 8, 30)), 'inverno')
        self.assertEqual(resolve('auto', date(2026, 5, 4)), 'classico')
        self.assertEqual(resolve('auto', date(2026, 9, 7)), 'classico')
        self.assertEqual(resolve('auto', date(2026, 11, 18)), 'classico')

    def test_chosen_look_is_kept(self):
        resolve = self.sabi['sabi_effective_look']
        self.assertEqual(resolve('natal', date(2026, 5, 4)), 'natal')
        self.assertEqual(resolve('inverno', date(2026, 12, 25)), 'inverno')

    def test_unknown_look_falls_back_to_classico(self):
        self.assertEqual(self.sabi['sabi_effective_look']('casaco', date(2026, 6, 1)), 'classico')

    def test_missing_setting_means_auto(self):
        self.assertEqual(self.sabi['sabi_look'](self.db), 'auto')
        self.assertEqual(self.sabi['sabi_payload'](self.db)['look'], 'auto')

    def test_stored_look_is_loaded(self):
        self.store('junina')
        self.assertEqual(self.sabi['sabi_look'](self.db), 'junina')
        self.assertEqual(self.sabi['sabi_payload'](self.db)['effective'], 'junina')

    def test_invalid_stored_value_reads_as_auto(self):
        self.store('toga')
        self.assertEqual(self.sabi['sabi_look'](self.db), 'auto')

    def test_payload_lists_all_looks(self):
        payload = self.sabi['sabi_payload'](self.db)
        self.assertEqual(payload['looks'], list(self.sabi['SABI_LOOKS']))
        self.assertIn(payload['effective'], self.sabi['SABI_LOOKS'])


if __name__ == '__main__':
    unittest.main()
