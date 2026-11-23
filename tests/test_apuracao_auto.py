import ast
import json
import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import s4e_connector as s4e

ROOT = Path(__file__).resolve().parent.parent / 'portal_server.py'


def load_auto_helpers():
    source = ast.parse(ROOT.read_text(encoding='utf-8'))
    wanted = {
        'AUTO_TZ', 'AUTO_WINDOW_START', 'AUTO_WINDOW_END',
        'APURACAO_AUTO_INTERVAL', 'APURACAO_AUTO_BACKOFF', 'COBRANCA_AUTO_INTERVAL',
    }
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {
        '_auto_now', '_auto_window_open', '_auto_age_minutes', '_auto_due',
    }]
    nodes += [
        node for node in source.body
        if isinstance(node, ast.Assign)
        and all(isinstance(target, ast.Name) and target.id in wanted for target in node.targets)
    ]
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    namespace = {'datetime': datetime, 'timedelta': timedelta, 'timezone': timezone}
    exec(compile(module, 'isolated-auto-schedule', 'exec'), namespace)
    return namespace


def load_cache_helpers():
    source = ast.parse(ROOT.read_text(encoding='utf-8'))
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {
        '_auto_age_minutes', '_auto_within', '_apuracao_timings', 'apuracao_nf_cache', 'apuracao_nf_cache_save',
    }]
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    namespace = {
        'json': json,
        'datetime': datetime,
        'timezone': timezone,
        'now_iso': lambda: datetime.now(timezone.utc).isoformat(),
    }
    exec(compile(module, 'isolated-nf-cache', 'exec'), namespace)
    return namespace


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.auto = load_auto_helpers()

    def local(self, weekday, hour, minute=0):
        base = datetime(2026, 11, 9, hour, minute, tzinfo=self.auto['AUTO_TZ'])  # segunda-feira
        return base.replace(day=base.day + weekday)

    def test_window_is_weekdays_seven_to_nineteen(self):
        open_window = self.auto['_auto_window_open']
        self.assertFalse(open_window(self.local(0, 6, 59)))
        self.assertTrue(open_window(self.local(0, 7, 0)))
        self.assertTrue(open_window(self.local(4, 18, 59)))
        self.assertFalse(open_window(self.local(4, 19, 0)))
        self.assertFalse(open_window(self.local(5, 10, 0)))
        self.assertFalse(open_window(self.local(6, 10, 0)))

    def test_due_uses_last_run_age(self):
        due = self.auto['_auto_due']
        now = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(due('', 30, now))
        self.assertFalse(due('2026-11-13T11:45:00+00:00', 30, now))
        self.assertTrue(due('2026-11-13T11:30:00+00:00', 30, now))
        self.assertTrue(due('2026-11-13T11:00:00+00:00', 30, now))
        self.assertFalse(due('2026-11-13T11:15:00+00:00', 60, now))

    def test_broken_timestamp_is_treated_as_never_run(self):
        due = self.auto['_auto_due']
        self.assertTrue(due('não é data', 30, datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)))

    def test_intervals_are_conservative(self):
        self.assertEqual(self.auto['APURACAO_AUTO_INTERVAL'], 30)
        self.assertEqual(self.auto['APURACAO_AUTO_BACKOFF'], 60)
        self.assertEqual(self.auto['COBRANCA_AUTO_INTERVAL'], 180)


class NfCacheTests(unittest.TestCase):
    def setUp(self):
        self.helpers = load_cache_helpers()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute(
            "CREATE TABLE apuracao_nf_lots (lot TEXT PRIMARY KEY, links TEXT NOT NULL DEFAULT '[]', fetched_at TEXT NOT NULL DEFAULT '')"
        )

    def tearDown(self):
        self.db.close()

    def test_cache_roundtrip_keeps_client_and_note(self):
        save = self.helpers['apuracao_nf_cache_save']
        load = self.helpers['apuracao_nf_cache']
        save(self.db, {'900': {('3909', '10498077'): 'https://www.nfse.gov.br/ConsultaPublica/?t=abc'}})
        cached = load(self.db)
        self.assertEqual(cached['900'][('3909', '10498077')], 'https://www.nfse.gov.br/ConsultaPublica/?t=abc')

    def test_empty_links_are_cached_only_for_one_day(self):
        save = self.helpers['apuracao_nf_cache_save']
        load = self.helpers['apuracao_nf_cache']
        save(self.db, {'900': {}})
        self.assertEqual(load(self.db), {'900': {}})
        self.db.execute("UPDATE apuracao_nf_lots SET fetched_at = '2026-01-01T00:00:00+00:00' WHERE lot = '900'")
        self.assertEqual(load(self.db), {})

    def test_corrupt_cache_is_ignored(self):
        self.db.execute("INSERT INTO apuracao_nf_lots(lot, links) VALUES ('900', 'not json')")
        self.assertEqual(self.helpers['apuracao_nf_cache'](self.db), {})

    def test_timings_are_normalized(self):
        timings = self.helpers['_apuracao_timings']('{"relatorio": 21.34, "notas": 3, "x": "y"}')
        self.assertEqual(timings, {'relatorio': 21.3, 'notas': 3.0})
        self.assertEqual(self.helpers['_apuracao_timings']('broken'), {})


class FakeSession:
    def __init__(self):
        self.cloned = 0

    def clone(self):
        self.cloned += 1
        return self


class PruneTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(ROOT.read_text(encoding='utf-8'))
        node = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'apuracao_prune_runs')
        module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
        keep = next(
            node for node in source.body
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == 'APURACAO_KEEP_RUNS' for target in node.targets
            )
        )
        module.body.insert(0, keep)
        self.namespace = {}
        exec(compile(module, 'isolated-prune', 'exec'), self.namespace)
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE apuracao_runs (id TEXT PRIMARY KEY, competencia_label TEXT, status TEXT, started_at TEXT, file_path TEXT)")
        self.db.execute("CREATE TABLE apuracao_rows (run_id TEXT)")

    def tearDown(self):
        self.db.close()

    def test_keeps_most_recent_runs_and_returns_old_files(self):
        for index in range(5):
            self.db.execute(
                "INSERT INTO apuracao_runs VALUES (?, 'Novembro/2026', 'done', ?, ?)",
                (f'r{index}', f'2026-11-13T1{index}:00:00+00:00', f'C:/tmp/r{index}.xlsx'),
            )
            self.db.execute("INSERT INTO apuracao_rows VALUES (?)", (f'r{index}',))
        self.db.execute("INSERT INTO apuracao_runs VALUES ('other', 'Outubro/2026', 'done', '2026-10-01T00:00:00+00:00', '')")
        files = self.namespace['apuracao_prune_runs'](self.db, 'Novembro/2026', keep=2)
        self.assertEqual(files, ['C:/tmp/r2.xlsx', 'C:/tmp/r1.xlsx', 'C:/tmp/r0.xlsx'])
        remaining = [row['id'] for row in self.db.execute("SELECT id FROM apuracao_runs ORDER BY started_at")]
        self.assertEqual(remaining, ['other', 'r3', 'r4'])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM apuracao_rows").fetchone()[0], 2)

    def test_running_run_is_never_pruned(self):
        self.db.execute("INSERT INTO apuracao_runs VALUES ('live', 'Novembro/2026', 'running', '2020-01-01T00:00:00+00:00', '')")
        self.db.execute("INSERT INTO apuracao_runs VALUES ('new', 'Novembro/2026', 'done', '2026-11-13T00:00:00+00:00', '')")
        self.namespace['apuracao_prune_runs'](self.db, 'Novembro/2026', keep=1)
        ids = {row['id'] for row in self.db.execute("SELECT id FROM apuracao_runs")}
        self.assertEqual(ids, {'live', 'new'})


class NfLinkTests(unittest.TestCase):
    def rows(self):
        return [
            {'cdAssociado': '3909', 'nf': '10498077', 'nfLote': '900', 'nfUrl': ''},
            {'cdAssociado': '3910', 'nf': '10498078', 'nfLote': '901', 'nfUrl': ''},
            {'cdAssociado': '3911', 'nf': '', 'nfLote': '', 'nfUrl': ''},
        ]

    def test_cached_lots_are_not_requested_again(self):
        session = FakeSession()
        requested = []
        cached = {'900': {('3909', '10498077'): 'https://www.nfse.gov.br/ConsultaPublica/?t=old'}}

        def fake_fetch(_session, lot):
            requested.append(lot)
            return {('3910', '10498078'): 'https://www.nfse.gov.br/ConsultaPublica/?t=new'}

        rows = self.rows()
        fresh = {}
        with patch.object(s4e, '_fetch_nf_lot', fake_fetch):
            s4e.attach_faturamento_nf_links(
                session, rows, cached=cached,
                on_lot=lambda lot, links: fresh.__setitem__(lot, links),
            )
        self.assertEqual(requested, ['901'])
        self.assertEqual(rows[0]['nfUrl'], 'https://www.nfse.gov.br/ConsultaPublica/?t=old')
        self.assertEqual(rows[1]['nfUrl'], 'https://www.nfse.gov.br/ConsultaPublica/?t=new')
        self.assertEqual(rows[2]['nfUrl'], '')
        self.assertIn('901', fresh)

    def test_failed_lot_does_not_break_or_cache(self):
        session = FakeSession()
        rows = self.rows()[:1]
        fresh = {}

        def fake_fetch(_session, _lot):
            raise s4e.ConnectorError('falhou')

        with patch.object(s4e, '_fetch_nf_lot', fake_fetch):
            s4e.attach_faturamento_nf_links(session, rows, on_lot=lambda lot, links: fresh.__setitem__(lot, links))
        self.assertEqual(rows[0]['nfUrl'], '')
        self.assertEqual(fresh, {})


class ContactReuseTests(unittest.TestCase):
    def setUp(self):
        self.saved_job = dict(s4e._job)

    def tearDown(self):
        with s4e._job_lock:
            s4e._job.clear()
            s4e._job.update(self.saved_job)

    def test_auto_import_reuses_saved_contacts_and_fetches_only_missing(self):
        rows = [
            {'cdAssociado': '3909', 'documento': '111', 'valor': 10.0, 'cliente': 'A', 'categoria': 'mensalidade'},
            {'cdAssociado': '3910', 'documento': '222', 'valor': 20.0, 'cliente': 'B', 'categoria': 'mensalidade'},
            {'cdAssociado': '3911', 'documento': '333', 'valor': 30.0, 'cliente': 'C', 'categoria': 'mensalidade'},
        ]
        fetched = []

        def fake_contacts(_session, code, _documento):
            fetched.append(code)
            return {'emails': [f'{code}@x.com'], 'phones': ['11999999999']}

        captured = {}

        def importer(imported_rows, **kwargs):
            captured['rows'] = imported_rows
            captured['kwargs'] = kwargs
            return {'importId': 'x', 'total': len(imported_rows)}

        with patch.object(s4e, 'ensure_session', lambda: FakeSession()), \
                patch.object(s4e, '_collect_rows', lambda start, end: rows), \
                patch.object(s4e, 'fetch_contacts', fake_contacts):
            s4e._import_worker(
                {
                    'withContacts': True,
                    'source': 's4e-auto',
                    'existingContacts': {
                        '3909': {'emails': ['a@x.com'], 'phones': ['11888888888']},
                        '3910': {'emails': [], 'phones': ['11777777777']},
                    },
                },
                importer,
            )

        self.assertEqual(sorted(fetched), ['3910', '3911'])
        contacts = {row['cdAssociado']: (row['emails'], row['phones']) for row in captured['rows']}
        self.assertEqual(contacts['3909'], (['a@x.com'], ['11888888888']))
        self.assertEqual(contacts['3910'], (['3910@x.com'], ['11777777777', '11999999999']))
        self.assertEqual(captured['kwargs']['source'], 's4e-auto')
        self.assertTrue(captured['kwargs']['full_scope'])
        self.assertFalse(s4e.job_status()['running'])


if __name__ == '__main__':
    unittest.main()
