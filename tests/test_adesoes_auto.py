import ast
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import adesoes_conferencia as ad

ROOT = Path(__file__).resolve().parent.parent / 'portal_server.py'


def load_auto_helpers():
    source = ast.parse(ROOT.read_text(encoding='utf-8'))
    names = {'_adesoes_auto_slot', '_adesoes_faturamento_mesclar', '_adesoes_vendas_guardar_recente'}
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    constants = {
        'ADESOES_AUTO_WINDOW_MINUTES',
    }
    nodes += [
        node for node in source.body
        if isinstance(node, ast.Assign)
        and all(isinstance(target, ast.Name) and target.id in constants for target in node.targets)
    ]
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    namespace = {
        'json': json, 'os': os, 'Path': Path, 'date': date,
        'timedelta': timedelta, 'adesoes_conferencia': ad,
        '_auto_now': lambda: datetime(2026, 11, 18, 16, 30, tzinfo=timezone(timedelta(hours=-3))),
    }
    exec(compile(module, 'isolated-adesoes-auto', 'exec'), namespace)
    return namespace


class SlotTests(unittest.TestCase):
    def setUp(self):
        self.slot = load_auto_helpers()['_adesoes_auto_slot']

    def local(self, hour, minute=0):
        return datetime(2026, 11, 18, hour, minute, tzinfo=timezone(timedelta(hours=-3)))

    def test_runs_at_ten_and_sixteen_within_ninety_minutes(self):
        self.assertEqual(self.slot(self.local(10, 0)).hour, 10)
        self.assertEqual(self.slot(self.local(11, 29)).hour, 10)
        self.assertEqual(self.slot(self.local(16, 0)).hour, 16)
        self.assertEqual(self.slot(self.local(17, 29)).hour, 16)

    def test_outside_the_window_nothing_runs(self):
        for hour, minute in ((9, 59), (11, 30), (15, 59), (17, 30), (23, 0)):
            self.assertIsNone(self.slot(self.local(hour, minute)))


class FaturamentoMergeTests(unittest.TestCase):
    def setUp(self):
        self.helpers = load_auto_helpers()
        self.dir = tempfile.TemporaryDirectory()
        self.cache = Path(self.dir.name) / 'faturamento.json'
        self.cache.write_text(json.dumps({
            'inicio': '2025-12-01',
            'fim': '2026-11-17',
            'linhas': [
                {'parcela': '1', 'vencimento': '2025-12-10', 'dataPagamento': '2025-12-10'},
                {'parcela': '2', 'vencimento': '2026-10-05', 'dataPagamento': ''},
                {'parcela': '3', 'vencimento': '2026-10-20', 'dataPagamento': ''},
                {'parcela': '4', 'vencimento': '', 'dataPagamento': ''},
            ],
        }), encoding='utf-8')

    def tearDown(self):
        self.dir.cleanup()

    def test_replaces_only_the_window_and_keeps_older_titles(self):
        frescas = [
            {'parcela': '2', 'vencimento': '2026-10-05', 'dataPagamento': '2026-10-06'},
            {'parcela': '5', 'vencimento': '2026-11-10', 'dataPagamento': ''},
        ]
        resumo = self.helpers['_adesoes_faturamento_mesclar'](
            self.cache, frescas, date(2026, 10, 1), date(2026, 11, 18))
        dados = json.loads(self.cache.read_text(encoding='utf-8'))
        parcelas = {linha['parcela']: linha for linha in dados['linhas']}
        self.assertEqual(set(parcelas), {'1', '2', '4', '5'})
        self.assertEqual(parcelas['2']['dataPagamento'], '2026-10-06')
        self.assertEqual(dados['inicio'], '2025-12-01')
        self.assertEqual(dados['fim'], '2026-11-18')
        self.assertEqual(resumo['baixadas'], 2)
        self.assertEqual(resumo['linhas'], 4)

    def test_missing_cache_starts_from_the_window(self):
        self.cache.unlink()
        resumo = self.helpers['_adesoes_faturamento_mesclar'](
            self.cache, [{'parcela': '9', 'vencimento': '2026-11-18'}],
            date(2026, 10, 1), date(2026, 11, 18))
        self.assertEqual(resumo['de'], '2026-10-01')
        self.assertEqual(resumo['linhas'], 1)


class VendasKeepTests(unittest.TestCase):
    def setUp(self):
        self.guardar = load_auto_helpers()['_adesoes_vendas_guardar_recente']
        self.db = sqlite3.connect(':memory:')
        self.db.execute(
            'CREATE TABLE vendas_snapshots (id INTEGER PRIMARY KEY, start_date TEXT, end_date TEXT)'
        )
        for dia in (11, 13, 16, 17, 18):
            self.db.execute(
                "INSERT INTO vendas_snapshots(start_date, end_date) VALUES ('2026-11-01', ?)",
                (f'2026-11-{dia}',),
            )
        self.db.execute(
            "INSERT INTO vendas_snapshots(start_date, end_date) VALUES ('2026-10-01', '2026-10-31')"
        )

    def tearDown(self):
        self.db.close()

    def test_keeps_the_two_latest_of_the_month_and_other_months(self):
        self.guardar(self.db, date(2026, 11, 1))
        ids = [row[0] for row in self.db.execute('SELECT id FROM vendas_snapshots ORDER BY id')]
        self.assertEqual(ids, [4, 5, 6])


class AutoStateTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')

    def tearDown(self):
        self.db.close()

    def test_roundtrip_keeps_last_result_and_hours(self):
        ad.auto_registrar(self.db, {'slot': '2026-11-18T16:00', 'at': '2026-11-18T16:02:00-03:00', 'ok': True})
        estado = ad.auto_estado(self.db)
        self.assertEqual(estado['slot'], '2026-11-18T16:00')
        self.assertTrue(estado['ok'])
        self.assertEqual(estado['horarios'], [10, 16])

    def test_corrupt_state_is_ignored(self):
        self.db.execute("INSERT INTO meta VALUES ('adesoes_auto_last', 'não é json')")
        self.assertEqual(ad.auto_estado(self.db), {})
        self.db.execute("UPDATE meta SET value = '[]' WHERE key = 'adesoes_auto_last'")
        self.assertEqual(ad.auto_estado(self.db), {})


if __name__ == '__main__':
    unittest.main()
