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
    'now_iso', 'normalize_name', 'digits_only', 'contract_key', 'contract_money',
    'contract_date', 'contract_cnpj', 'contract_cpf', 'is_manager',
    'contracts_allowed', 'commissions_allowed', 'require_contracts', 'require_commissions',
    'current_user', 'require_user', 'user_seller_name', 'user_seller_key',
    'can_edit_contract_values', 'contract_company_updates', 'contract_create_company',
    'contract_life_key', 'contract_import', 'contract_company_view',
    'contract_company_payload', 'contract_life_payload', 'commission_scope', 'company_in_scope',
    'ensure_contract_events_schema', 'contract_record_created', 'contract_events_page',
    'ensure_contract_registration_schema',
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
    namespace = {'re': re, 'uuid': uuid, 'unicodedata': unicodedata, 'date': date,
                 'datetime': datetime, 'timedelta': timedelta, 'timezone': timezone,
                 'parse_qs': parse_qs, 'urlparse': urlparse, 'unquote': unquote,
                 'CONTRACT_CLIENT_TYPES': ('Empresa', 'Sindicato', 'Associação', 'Pessoa Física'),
                 'CONTRACT_MAX_UPLOAD': 12_000_000, 'COMMISSION_RATE': 0.4}
    definitions = [copy.deepcopy(node) for node in TREE.body
                   if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    assert {node.name for node in definitions} == FUNCTIONS
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE_PATH), 'exec'), namespace)
    connection = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'connection')
    start = next(i for i, node in enumerate(connection.body) if sql_contains(node, 'CREATE TABLE IF NOT EXISTS contract_companies'))
    end = next(i for i, node in enumerate(connection.body) if sql_contains(node, 'CREATE TABLE IF NOT EXISTS contract_imports'))
    compile_body('synthetic_schema', connection.body[start:end + 1], namespace, 'db')
    handler = next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == 'PortalHandler')
    get = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == 'do_GET')
    event_index = next(i for i, node in enumerate(get.body) if isinstance(node, ast.If) and ast.unparse(node.test) == "path == '/api/contracts/events'")
    generic_index = next(i for i, node in enumerate(get.body) if isinstance(node, ast.If) and "path.startswith('/api/contracts/')" in ast.unparse(node.test))
    assert event_index < generic_index, 'Events must route before generic company IDs'
    prelude = ast.parse('path = urlparse(self.path).path').body
    compile_body('events_get', prelude + [get.body[event_index]], namespace)
    post = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == 'do_POST')
    upload = next(node for node in post.body if isinstance(node, ast.If) and '/api/contracts/preview' in ast.unparse(node.test))
    compile_body('upload_post', prelude + [upload], namespace)
    return namespace


class Handler:
    def __init__(self, path, token='', body=b'synthetic-xlsx'):
        self.path = path
        self.headers = {'Authorization': f'Bearer {token}', 'Content-Length': str(len(body))}
        self.rfile = io.BytesIO(body)
        self.response = None

    def send_json(self, payload, status=200):
        self.response = (status, payload)


def parsed_company(name='Empresa sintética', cnpj='12.345.678/0001-99', lives=None):
    company = {key: '' for key in ('contact_name', 'phone', 'email', 'accountant_name',
                                  'accountant_email', 'plan', 'seller', 'contract_start', 'notes')}
    company.update(name=name, cnpj=cnpj, monthly_value=0)
    return {'company': company, 'lives': lives or [], 'warnings': []}


def synthetic_life(name='Vida sintética', cpf='12345678901'):
    life = {key: '' for key in ('birth_date', 'mother_name', 'phone', 'email', 'role', 'notes')}
    life.update(name=name, cpf=cpf)
    return life


class ContractEventsTests(unittest.TestCase):
    def setUp(self):
        self.code = isolated_code()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.code['synthetic_schema'](self.db)
        self.db.executescript('''
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, active INTEGER DEFAULT 1,
                management INTEGER DEFAULT 0, display_name TEXT, seller_name TEXT DEFAULT '');
            CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id TEXT);
            CREATE TABLE user_screens(user_id TEXT, screen_id TEXT);
        ''')
        for user_id, role, active, management in [('admin', 'admin', 1, 0), ('allowed', 'user', 1, 0),
                                                ('denied', 'user', 1, 0), ('seller', 'user', 1, 0),
                                                ('manager', 'user', 1, 1), ('inactive', 'admin', 0, 0)]:
            self.db.execute('INSERT INTO users(id,role,active,management,display_name) VALUES(?,?,?,?,?)',
                            (user_id, role, active, management, 'Pessoa sintética'))
            self.db.execute('INSERT INTO sessions VALUES(?,?)', ('test-' + user_id, user_id))
        self.db.execute("INSERT INTO user_screens VALUES('allowed','contractsScreen')")
        self.db.execute("INSERT INTO user_screens VALUES('seller','commissionsScreen')")
        self.db.commit()
        self.user = self.db.execute("SELECT * FROM users WHERE id='admin'").fetchone()
        self.code['connection'] = lambda: nullcontext(self.db)
        self.code['contract_parse_xlsx'] = lambda _: copy.deepcopy(self.parsed)
        self.parsed = parsed_company()

    def tearDown(self):
        self.db.close()

    def count(self, table='contract_events'):
        return self.db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def create(self, name='Contrato sintético', cnpj='12345678000199'):
        return self.code['contract_create_company'](self.db, {'name': name, 'cnpj': cnpj}, self.user)

    def import_company(self, parsed=None, replace=False):
        return self.code['contract_import'](self.db, parsed or self.parsed, 'synthetic.xlsx', self.user, replace)

    def get(self, query='', token='test-admin'):
        handler = Handler('/api/contracts/events' + query, token)
        self.code['events_get'](handler)
        return handler.response

    def test_manual_creation_and_uuid_dedup(self):
        with self.db:
            row = self.create()
        event = self.db.execute('SELECT * FROM contract_events').fetchone()
        self.assertEqual(event['company_id'], row['id'])
        self.assertEqual(event['event_type'], 'contract_created')
        uuid.UUID(event['company_id'])
        self.assertEqual(event['created_at'], row['created_at'])
        self.code['contract_record_created'](self.db, row['id'], row['created_at'])
        self.assertEqual(self.count(), 1)
        with self.assertRaises(ValueError), self.db:
            self.create()
        self.assertEqual(self.count(), 1)

    def test_import_only_new_company_not_cnpj_updates_lives_or_replacement(self):
        self.parsed['lives'] = [synthetic_life()]
        first = self.import_company()
        self.assertEqual(first['companiesCreated'], 1)
        self.assertEqual(self.count(), 1)
        self.parsed['company']['name'] = 'Nome atualizado'
        self.parsed['lives'].append(synthetic_life('Outra vida', '23456789012'))
        updated = self.import_company()
        self.assertEqual(updated['companyId'], first['companyId'])
        self.assertEqual(updated['companiesCreated'], 0)
        self.assertEqual(updated['livesCreated'], 1)
        self.parsed['lives'] = []
        self.assertEqual(self.import_company(replace=True)['livesRemoved'], 2)
        self.assertEqual(self.count(), 1)

    def test_manual_then_import_and_name_dedup_without_cnpj(self):
        with self.db:
            row = self.create(name='  Empresa sintética  ', cnpj='')
        self.parsed['company']['cnpj'] = ''
        self.parsed['company']['name'] = 'empresa sintética'
        result = self.import_company()
        self.assertEqual(result['companyId'], row['id'])
        self.assertEqual(result['companiesCreated'], 0)
        self.assertEqual(self.count(), 1)

    def test_new_imports_each_have_one_event(self):
        first = self.import_company()
        second = self.import_company(parsed_company('Outra empresa', '23456789000188'))
        self.assertNotEqual(first['companyId'], second['companyId'])
        self.assertEqual(self.count(), 2)

    def test_no_backfill_on_schema_or_old_company_update(self):
        self.db.execute('DROP TABLE contract_events')
        self.db.execute("INSERT INTO contract_companies(id,name,created_at,updated_at) VALUES('old','Antiga','2000','2000')")
        self.code['ensure_contract_events_schema'](self.db)
        self.code['ensure_contract_events_schema'](self.db)
        self.assertEqual(self.count(), 0)
        self.import_company(parsed_company('Antiga', ''))
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.get()[1]['cursor'], 0)

    def test_manual_company_and_event_rollback_together(self):
        with self.assertRaises(RuntimeError), self.db:
            self.create()
            self.assertEqual(self.count(), 1)
            raise RuntimeError('synthetic later transaction failure')
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.count('contract_companies'), 0)

    def test_import_later_failure_rolls_back_company_lives_and_event(self):
        self.db.execute("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON contract_imports BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
        self.db.commit()
        self.parsed['lives'] = [synthetic_life()]
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.import_company()
        for table in ('contract_companies', 'contract_lives', 'contract_events', 'contract_imports'):
            self.assertEqual(self.count(table), 0)

    def test_event_insert_failure_cannot_commit_company(self):
        self.db.execute("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON contract_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.create()
        self.assertEqual(self.count('contract_companies'), 0)

    def test_deletion_retains_event_and_sequence(self):
        with self.db:
            row = self.create()
        first = self.db.execute('SELECT id FROM contract_events').fetchone()[0]
        with self.db:
            self.db.execute('DELETE FROM contract_companies WHERE id=?', (row['id'],))
            self.create('Outro contrato', '')
        self.assertEqual(self.count(), 2)
        self.assertGreater(self.get()[1]['cursor'], first)

    def test_endpoint_quiet_baseline_pagination_and_generic_payload(self):
        with self.db:
            for index in range(105):
                self.create(f'Contrato {index}', '')
        status, baseline = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(baseline, {'events': [], 'cursor': 105, 'hasMore': False, 'baseline': True})
        status, page = self.get('?after=0')
        self.assertEqual(status, 200)
        self.assertEqual(len(page['events']), 100)
        self.assertTrue(page['hasMore'])
        self.assertEqual(page['cursor'], 100)
        self.assertFalse(page['baseline'])
        self.assertEqual(set(page['events'][0]), {'id', 'type', 'createdAt'})
        _, second = self.get('?after=100&limit=2')
        self.assertEqual([item['id'] for item in second['events']], [101, 102])
        _, last = self.get('?after=102')
        self.assertEqual([item['id'] for item in last['events']], [103, 104, 105])
        self.assertFalse(last['hasMore'])
        self.assertEqual(self.get('?after=105')[1]['events'], [])

    def test_endpoint_validates_bounded_single_integer_parameters(self):
        for query in ('?after=', '?after=-1', '?after=1.5', '?after=NaN', '?after=1&after=2',
                      '?after=9007199254740992', '?limit=', '?limit=0', '?limit=101', '?limit=-1',
                      '?limit=1&limit=2', '?limit=1e2', '?after=+1', '?after=%20'):
            with self.subTest(query=query):
                self.assertEqual(self.get(query)[0], 400)
        self.assertEqual(self.get('?after=9007199254740991')[1]['baseline'], True)

    def test_endpoint_auth_and_contract_screen_permission(self):
        for token in ('', 'bad', 'test-inactive'):
            self.assertEqual(self.get('?after=bad', token)[0], 401)
        for token in ('test-denied', 'test-seller'):
            self.assertEqual(self.get('?after=bad', token)[0], 403)
        for token in ('test-admin', 'test-allowed', 'test-manager'):
            self.assertEqual(self.get(token=token)[0], 200)

    def test_actual_upload_preview_is_read_only_and_import_repetition_is_quiet(self):
        for path in ('/api/contracts/preview', '/api/commissions/preview'):
            handler = Handler(path, 'test-admin')
            self.code['upload_post'](handler)
            self.assertEqual(handler.response[0], 200)
            self.assertEqual(self.count('contract_companies'), 0)
            self.assertEqual(self.count(), 0)
        for path in ('/api/contracts/import', '/api/commissions/import'):
            handler = Handler(path, 'test-admin')
            self.code['upload_post'](handler)
            self.assertEqual(handler.response[0], 201)
        self.assertEqual(self.count(), 1)


if __name__ == '__main__':
    unittest.main()
