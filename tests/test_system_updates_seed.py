"""Synthetic tests for the changelog seed; never opens portal.db."""
import ast
import copy
import sqlite3
import unittest
from datetime import datetime
from pathlib import Path


SOURCE_PATH = Path(__file__).resolve().parent.parent / 'portal_server.py'
TREE = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), filename=str(SOURCE_PATH))

REQUIRED_TITLES = {
    'Cobrança automática',
    'Apuração automática',
    'Retorno Instituição',
    'Acompanhamento de Vendas',
    'Avisos de contratos e cadastros',
    'Demandas sem internet',
    'Movimentação de Vidas',
    'Inclusão e Exclusão de vidas',
    'Conferência de Notas',
    'Recibos em PDF',
    'Empresa cadastrada nas Comissões',
    'Status do time',
}


def assignment(name):
    return next(
        node for node in TREE.body
        if isinstance(node, ast.Assign) and any(getattr(target, 'id', '') == name for target in node.targets)
    )


def function(name):
    return next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == name)


def load_seed():
    namespace = {'now_iso': lambda: '2026-11-13T12:00:00+00:00'}
    for name in ('SYSTEM_UPDATE_SEED', 'SYSTEM_UPDATE_SEED_V2'):
        namespace[name] = ast.literal_eval(assignment(name).value)
    for name in ('seed_system_updates', 'seed_system_updates_v2'):
        module = ast.Module(body=[copy.deepcopy(function(name))], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(SOURCE_PATH), 'exec'), namespace)
    return namespace


def scratch_db():
    db = sqlite3.connect(':memory:')
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute(
        "CREATE TABLE system_updates ("
        "id TEXT PRIMARY KEY, title TEXT NOT NULL, "
        "body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    )
    return db


class SystemUpdatesSeedTest(unittest.TestCase):
    def setUp(self):
        self.seed = load_seed()
        self.db = scratch_db()
        self.seed['seed_system_updates'](self.db)
        self.seed['seed_system_updates_v2'](self.db)

    def tearDown(self):
        self.db.close()

    def rows(self, prefix='update-v2-'):
        return self.db.execute(
            "SELECT id, title, body, created_at FROM system_updates WHERE id LIKE ? ORDER BY created_at",
            (f'{prefix}%',),
        ).fetchall()

    def test_first_run_keeps_previous_entries_and_adds_all_new_ones(self):
        total = self.db.execute("SELECT COUNT(*) FROM system_updates").fetchone()[0]
        self.assertEqual(total, len(self.seed['SYSTEM_UPDATE_SEED']) + len(self.seed['SYSTEM_UPDATE_SEED_V2']))
        self.assertEqual(len(self.rows()), len(self.seed['SYSTEM_UPDATE_SEED_V2']))
        self.assertIsNotNone(
            self.db.execute("SELECT 1 FROM meta WHERE key = 'system_updates_seed_v2'").fetchone()
        )

    def test_second_run_does_not_duplicate(self):
        before = self.rows()
        self.seed['seed_system_updates_v2'](self.db)
        self.assertEqual(self.rows(), before)

    def test_ids_and_titles_are_unique(self):
        ids = [row[0] for row in self.rows()]
        titles = [row[1] for row in self.rows()]
        old_titles = [item[0] for item in self.seed['SYSTEM_UPDATE_SEED']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(titles), len(set(titles)))
        self.assertFalse(set(titles) & set(old_titles), 'A novidade não pode repetir o changelog anterior')

    def test_every_entry_has_valid_text_and_date(self):
        for update_id, title, body, created_at in self.rows():
            self.assertTrue(title.strip(), update_id)
            self.assertTrue(body.strip(), update_id)
            self.assertLessEqual(len(title), 160, update_id)
            self.assertLessEqual(len(body), 2000, update_id)
            moment = datetime.fromisoformat(created_at)
            self.assertGreaterEqual(moment.isoformat(), '2026-11-10', update_id)
            self.assertLessEqual(moment.isoformat(), '2026-11-13T23:59:59', update_id)

    def test_all_new_features_are_registered(self):
        titles = {row[1] for row in self.rows()}
        self.assertEqual(REQUIRED_TITLES - titles, set())

    def test_existing_row_is_preserved(self):
        self.db.execute("DELETE FROM meta WHERE key = 'system_updates_seed_v2'")
        self.db.execute("UPDATE system_updates SET title = 'Editado pela gestão' WHERE id = 'update-v2-01'")
        self.seed['seed_system_updates_v2'](self.db)
        title = self.db.execute("SELECT title FROM system_updates WHERE id = 'update-v2-01'").fetchone()[0]
        self.assertEqual(title, 'Editado pela gestão')

    def test_seed_runs_when_database_connects(self):
        connection = function('connection')
        calls = {
            node.func.id
            for node in ast.walk(connection)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn('seed_system_updates_v2', calls)


if __name__ == '__main__':
    unittest.main()
