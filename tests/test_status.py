"""Synthetic in-memory tests for the team status; never imports the server or opens portal.db."""
import ast
import copy
import re
import sqlite3
import unittest
from datetime import date, timedelta
from pathlib import Path


SOURCE_PATH = Path(__file__).resolve().parent.parent / 'portal_server.py'
SOURCE = SOURCE_PATH.read_text(encoding='utf-8')
TREE = ast.parse(SOURCE, filename=str(SOURCE_PATH))
FUNCTIONS = {'user_status', 'normalize_status', 'directory_member'}


def load():
    namespace = {
        're': re, 'date': date, 'timedelta': timedelta,
        'STATUS_TEXT_MAX': 80, 'STATUS_EMOJI_MAX': 8,
        'STATUS_DURATIONS': ('never', 'today', 'week'),
    }
    definitions = [copy.deepcopy(node) for node in TREE.body
                   if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    assert {node.name for node in definitions} == FUNCTIONS
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE_PATH), 'exec'), namespace)
    return namespace


STATUS = load()


def row(**values):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    columns = list(values) or ['id']
    db.execute(f"CREATE TABLE users ({', '.join(f'{name} TEXT' for name in columns)})")
    db.execute(f"INSERT INTO users ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
               tuple(values.get(name) for name in columns))
    return db.execute("SELECT * FROM users").fetchone()


class Normalize(unittest.TestCase):
    def test_empty_text_clears_status(self):
        self.assertEqual(STATUS['normalize_status']({'text': '   ', 'emoji': '😄', 'duration': 'today'}),
                         {'emoji': '', 'text': '', 'until': ''})

    def test_collapses_spaces_and_keeps_emoji(self):
        result = STATUS['normalize_status']({'text': '  Fechando\n os   repasses ', 'emoji': '😄'})
        self.assertEqual(result, {'emoji': '😄', 'text': 'Fechando os repasses', 'until': ''})

    def test_durations(self):
        today = date(2026, 11, 13)  # sexta-feira
        self.assertEqual(STATUS['normalize_status']({'text': 'Hoje', 'duration': 'today'}, today)['until'], '2026-11-13')
        self.assertEqual(STATUS['normalize_status']({'text': 'Semana', 'duration': 'week'}, today)['until'], '2026-11-15')
        self.assertEqual(STATUS['normalize_status']({'text': 'Sempre', 'duration': 'never'}, today)['until'], '')
        self.assertEqual(STATUS['normalize_status']({'text': 'Domingo', 'duration': 'week'}, date(2026, 11, 15))['until'], '2026-11-15')

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            STATUS['normalize_status']({'text': 'x' * 81})
        with self.assertRaises(ValueError):
            STATUS['normalize_status']({'text': 'ok', 'emoji': '😀' * 9})
        with self.assertRaises(ValueError):
            STATUS['normalize_status']({'text': 'ok', 'duration': 'forever'})

    def test_accepts_limit_lengths(self):
        self.assertEqual(len(STATUS['normalize_status']({'text': 'x' * 80})['text']), 80)
        self.assertEqual(STATUS['normalize_status']({'text': 'ok', 'emoji': '😀' * 4})['emoji'], '😀' * 4)


class Visible(unittest.TestCase):
    def test_active_status(self):
        status = STATUS['user_status'](row(status_emoji='☕', status_text='Pausa', status_until='2099-01-01'))
        self.assertEqual(status, {'emoji': '☕', 'text': 'Pausa', 'until': '2099-01-01'})

    def test_expired_status_disappears(self):
        past = (date.today() - timedelta(days=1)).isoformat()
        status = STATUS['user_status'](row(status_emoji='☕', status_text='Pausa', status_until=past))
        self.assertEqual(status, {'emoji': '', 'text': '', 'until': ''})

    def test_today_is_still_visible(self):
        status = STATUS['user_status'](row(status_emoji='', status_text='Hoje', status_until=date.today().isoformat()))
        self.assertEqual(status['text'], 'Hoje')

    def test_blank_text_hides_emoji(self):
        status = STATUS['user_status'](row(status_emoji='😄', status_text='   ', status_until=''))
        self.assertEqual(status, {'emoji': '', 'text': '', 'until': ''})

    def test_missing_columns_are_safe(self):
        self.assertEqual(STATUS['user_status'](row(id='u1', display_name='Ana')), {'emoji': '', 'text': '', 'until': ''})

    def test_directory_member_carries_status(self):
        member = STATUS['directory_member'](row(id='u1', display_name='Ana', role='user', photo='', status_emoji='🎯',
                                                status_text='Focada', status_until=''))
        self.assertEqual(member['status']['text'], 'Focada')
        self.assertEqual(member['status']['emoji'], '🎯')


class Wiring(unittest.TestCase):
    def test_schema_and_route_are_present(self):
        for column in ('status_emoji', 'status_text', 'status_until'):
            self.assertIn(f"ADD COLUMN {column}", SOURCE)
        self.assertIn('path == "/api/me/status"', SOURCE)
        self.assertIn('normalize_status(payload)', SOURCE)

    def test_profile_payload_exposes_status(self):
        self.assertIn('"status": user_status(user)', SOURCE)
        self.assertIn('"status": user_status(row)', SOURCE)


if __name__ == '__main__':
    unittest.main()
