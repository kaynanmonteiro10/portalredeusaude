"""Synthetic in-memory tests; never import/start the server or open portal.db."""
import ast
import copy
import io
import re
import sqlite3
import unicodedata
import unittest
import uuid
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


SOURCE_PATH = Path(__file__).resolve().parent.parent / 'portal_server.py'
TREE = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), filename=str(SOURCE_PATH))
FUNCTIONS = {
    'now_iso', 'normalize_name', 'digits_only', 'contract_key', 'is_manager',
    'contracts_allowed', 'commissions_allowed', 'require_contracts', 'require_commissions',
    'current_user', 'require_user', 'user_seller_name', 'user_seller_key',
    'contract_company_payload', 'contract_life_payload', 'contract_company_view',
    'contract_movement_payload', 'commission_company_payload', 'commission_scope',
    'company_in_scope', 'ensure_contract_events_schema',
    'ensure_contract_registration_schema', 'contract_registration_record',
    'contract_registration_events_page',
}


def sql_contains(node, text):
    return any(isinstance(item, ast.Constant) and isinstance(item.value, str) and text in item.value
               for item in ast.walk(node))


def compile_body(name, body, namespace, args='self'):
    function = ast.parse(f'def {name}({args}):\n    pass\n').body[0]
    function.body = copy.deepcopy(body)
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    exec(compile(module, str(SOURCE_PATH), 'exec'), namespace)


def isolated_code():
    namespace = {
        're': re, 'uuid': uuid, 'unicodedata': unicodedata, 'date': date,
        'datetime': datetime, 'timedelta': timedelta, 'timezone': timezone,
        'parse_qs': parse_qs, 'urlparse': urlparse, 'unquote': unquote,
        'COMMISSION_RATE': 0.4,
    }
    definitions = [copy.deepcopy(node) for node in TREE.body
                   if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    assert {node.name for node in definitions} == FUNCTIONS
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE_PATH), 'exec'), namespace)
    connection = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'connection')
    start = next(i for i, node in enumerate(connection.body) if sql_contains(node, 'CREATE TABLE IF NOT EXISTS contract_companies'))
    end = next(i for i, node in enumerate(connection.body) if sql_contains(node, 'CREATE TABLE IF NOT EXISTS contract_imports'))
    compile_body('synthetic_schema', connection.body[start:end + 1], namespace, 'db')
    handler = next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == 'PortalHandler')
    patch = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == 'do_PATCH')
    node = next(item for item in patch.body
                if isinstance(item, ast.If) and "parts[3] == 'registration'" in ast.unparse(item.test))
    prelude = ast.parse("path = urlparse(self.path).path\nparts = [unquote(part) for part in path.split('/') if part]").body
    compile_body('registration_patch', prelude + [node], namespace, 'self, payload')
    return namespace


class Handler:
    def __init__(self, path, token=''):
        self.path = path
        self.headers = {'Authorization': f'Bearer {token}'}
        self.response = None

    def send_json(self, payload, status=200):
        self.response = (status, payload)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.code = isolated_code()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.code['synthetic_schema'](self.db)
        self.db.executescript('''
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, active INTEGER DEFAULT 1,
                management INTEGER DEFAULT 0, display_name TEXT, username TEXT DEFAULT '',
                seller_name TEXT DEFAULT '');
            CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id TEXT);
            CREATE TABLE user_screens(user_id TEXT, screen_id TEXT);
        ''')
        for user_id, role, management, username in [
            ('admin', 'admin', 0, 'admin'), ('contracts', 'user', 0, 'contratos'),
            ('seller', 'user', 0, 'ana'), ('seller2', 'user', 0, 'bia'),
        ]:
            self.db.execute(
                'INSERT INTO users(id,role,active,management,display_name,username,seller_name) VALUES(?,?,1,?,?,?,?)',
                (user_id, role, management, username.title(), username, username.title()),
            )
            self.db.execute('INSERT INTO sessions VALUES(?,?)', (f'test-{user_id}', user_id))
        self.db.execute("INSERT INTO user_screens VALUES('contracts','contractsScreen')")
        self.db.execute("INSERT INTO user_screens VALUES('seller','commissionsScreen')")
        self.db.execute("INSERT INTO user_screens VALUES('seller2','commissionsScreen')")
        self.db.commit()
        self.code['connection'] = lambda: nullcontext(self.db)
        self.add('Empresa Ana', 'ana@example.com', 'Ana')
        self.add('Empresa Bia', 'bia@example.com', 'Bia')

    def tearDown(self):
        self.db.close()

    def add(self, name, email, seller):
        company_id = str(uuid.uuid4())
        self.db.execute(
            """INSERT INTO contract_companies(id,name,email,seller,created_at,updated_at)
               VALUES(?,?,?,?,?,?)""",
            (company_id, name, email, seller, '2026-11-01T10:00:00+00:00', '2026-11-01T10:00:00+00:00'),
        )
        self.db.commit()
        return company_id

    def mark(self, company_id, registered, token='test-contracts'):
        handler = Handler(f'/api/contracts/{company_id}/registration', token)
        self.code['registration_patch'](handler, {'registered': registered})
        return handler.response

    def page(self, query='', seller_key=None):
        return self.code['contract_registration_events_page'](
            self.db, parse_qs(query.lstrip('?'), keep_blank_values=True), seller_key,
        )

    def test_schema_adds_company_status_columns_idempotently(self):
        columns = {row[1] for row in self.db.execute('PRAGMA table_info(contract_companies)')}
        self.assertTrue({'registered', 'registered_at', 'registered_by'} <= columns)
        self.code['synthetic_schema'](self.db)
        self.assertEqual(self.db.execute('SELECT registered FROM contract_companies').fetchone()[0], 0)

    def test_mark_and_unmark_record_state_event_and_actor(self):
        company_id = self.db.execute("SELECT id FROM contract_companies WHERE name='Empresa Ana'").fetchone()[0]
        status, body = self.mark(company_id, True)
        self.assertEqual(status, 200)
        self.assertTrue(body['changed'])
        self.assertTrue(body['company']['companyRegistered'])
        self.assertEqual(body['company']['companyRegisteredBy'], 'Contratos')
        self.assertTrue(body['company']['companyRegisteredAt'])
        self.assertEqual(body['event']['registered'], True)
        self.assertEqual(self.page()['cursor'], 1)
        again = self.mark(company_id, True)[1]
        self.assertFalse(again['changed'])
        self.assertIsNone(again['event'])
        self.assertEqual(self.page()['cursor'], 1)
        body = self.mark(company_id, False)[1]
        self.assertTrue(body['changed'])
        self.assertFalse(body['company']['companyRegistered'])
        self.assertEqual(body['company']['companyRegisteredBy'], '')
        self.assertEqual(self.page()['cursor'], 2)

    def test_only_contracts_access_can_mark(self):
        company_id = str(uuid.uuid4())
        self.db.execute(
            "INSERT INTO contract_companies(id,name,seller,created_at,updated_at) VALUES(?,?,?,?,?)",
            (company_id, 'Outra', 'Ana', 'x', 'x'),
        )
        self.db.commit()
        self.assertEqual(self.mark(company_id, True, token='')[0], 401)
        self.assertEqual(self.mark(company_id, True, 'test-seller')[0], 403)
        self.assertTrue(self.mark(company_id, True, 'test-admin')[1]['changed'])
        self.assertTrue(self.mark(company_id, False, 'test-contracts')[1]['changed'])

    def test_missing_company_is_not_found(self):
        handler = Handler('/api/contracts/nao-existe/registration', 'test-contracts')
        self.code['registration_patch'](handler, {'registered': True})
        self.assertEqual(handler.response[0], 404)

    def test_events_are_seller_scoped_with_quiet_baseline(self):
        ana = self.db.execute("SELECT id FROM contract_companies WHERE name='Empresa Ana'").fetchone()[0]
        bia = self.db.execute("SELECT id FROM contract_companies WHERE name='Empresa Bia'").fetchone()[0]
        self.mark(ana, True)
        self.mark(bia, True)
        self.mark(ana, False)
        baseline = self.page(seller_key='ana')
        self.assertTrue(baseline['baseline'])
        self.assertEqual(baseline['cursor'], 3)
        page = self.page('?after=0', 'ana')
        self.assertEqual([event['registered'] for event in page['events']], [True, False])
        self.assertEqual({event['companyName'] for event in page['events']}, {'Empresa Ana'})
        self.assertEqual(page['cursor'], 3)
        self.assertFalse(page['hasMore'])
        self.assertEqual(self.page('?after=0')['events'][2]['companyName'], 'Empresa Ana')

    def test_pagination_and_parameter_validation(self):
        ana = self.db.execute("SELECT id FROM contract_companies WHERE name='Empresa Ana'").fetchone()[0]
        for index in range(3):
            self.db.execute(
                """INSERT INTO contract_registration_events(company_id,company_name,seller_key,registered,actor,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (ana, 'Empresa Ana', 'ana', index % 2, 'Ana', f'2026-11-0{index + 1}T10:00:00+00:00'),
            )
        self.db.commit()
        first = self.page('?after=0&limit=2')
        self.assertEqual([event['id'] for event in first['events']], [1, 2])
        self.assertTrue(first['hasMore'])
        self.assertEqual(first['cursor'], 2)
        second = self.page('?after=2&limit=2')
        self.assertEqual([event['id'] for event in second['events']], [3])
        self.assertFalse(second['hasMore'])
        for query in ('?after=', '?after=-1', '?after=1.5', '?limit=0', '?limit=101', '?after=1&after=2'):
            with self.subTest(query=query), self.assertRaises(ValueError):
                self.page(query)

    def test_commission_payload_exposes_registration_status(self):
        company_id = self.db.execute("SELECT id FROM contract_companies WHERE name='Empresa Ana'").fetchone()[0]
        self.mark(company_id, True)
        row = self.db.execute('SELECT * FROM contract_companies WHERE id=?', (company_id,)).fetchone()
        payload = self.code['commission_company_payload'](self.db, row)
        self.assertTrue(payload['companyRegistered'])
        self.assertEqual(payload['companyRegisteredBy'], 'Contratos')
        company, _ = self.code['contract_company_view'](self.db, company_id)
        self.assertTrue(company['companyRegistered'])


if __name__ == '__main__':
    unittest.main()
