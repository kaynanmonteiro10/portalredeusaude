"""O resumo semanal automático não pode abrir o overlay de ninguém sem liberação."""
import ast
import json
import sqlite3
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


SOURCE_PATH = Path(__file__).resolve().parent.parent / 'portal_server.py'
TREE = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), filename=str(SOURCE_PATH))


def load_digest():
    node = next(
        item for item in TREE.body
        if isinstance(item, ast.FunctionDef) and item.name == 'ensure_weekly_digest'
    )
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    namespace = {
        'json': json,
        'date': date,
        'datetime': datetime,
        'timezone': timezone,
        'timedelta': timedelta,
    }
    exec(compile(module, str(SOURCE_PATH), 'exec'), namespace)
    return namespace['ensure_weekly_digest']


WEEK_KEY = '{0}-W{1:02d}'.format(*date.today().isocalendar()[:2])


class WeeklyDigestDraftTest(unittest.TestCase):
    def setUp(self):
        self.ensure = load_digest()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.execute(
            "CREATE TABLE portal_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)"
        )
        self.db.execute(
            "CREATE TABLE feed_posts (id TEXT PRIMARY KEY, author_id TEXT, kind TEXT NOT NULL, "
            "title TEXT NOT NULL, body TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL)"
        )
        self.db.execute("CREATE TABLE contract_companies (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)")
        self.db.execute(
            "CREATE TABLE system_updates (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
            "body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
        )

    def tearDown(self):
        self.db.close()

    def state(self):
        row = self.db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
        return json.loads(row['data']) if row else {}

    def put_state(self, announcements, week=None):
        self.db.execute(
            "INSERT INTO portal_state(id, data) VALUES(1, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (json.dumps({'announcements': announcements}),),
        )
        if week:
            self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('feed_digest_week', ?)", (week,))
        self.db.commit()

    def announcements(self):
        return self.state().get('announcements') or []

    def digest(self, announcements):
        return next(item for item in announcements if item.get('weeklyDigest'))

    def test_new_digest_is_created_as_draft(self):
        self.ensure(self.db)
        digest = self.digest(self.announcements())
        self.assertFalse(digest['active'])
        self.assertTrue(digest['autoDraft'])
        self.assertTrue(digest['releaseManaged'])
        self.assertNotIn('releasedAt', digest)

    def test_active_digest_without_release_becomes_draft(self):
        self.put_state([{
            'id': 'ann-digest-antigo',
            'title': 'Resumo antigo',
            'description': 'texto',
            'date': date.today().isoformat(),
            'type': 'notice',
            'active': True,
            'weeklyDigest': True,
            'color': '#0b8f87',
        }], week=WEEK_KEY)
        self.ensure(self.db)
        digest = self.digest(self.announcements())
        self.assertFalse(digest['active'])
        self.assertTrue(digest['autoDraft'])
        self.assertTrue(digest['releaseManaged'])

    def test_published_digest_stays_published(self):
        self.put_state([{
            'id': 'ann-digest-antigo',
            'title': 'Resumo antigo',
            'description': 'texto',
            'date': date.today().isoformat(),
            'type': 'notice',
            'active': True,
            'releasedAt': datetime.now(timezone.utc).isoformat(),
            'autoDraft': False,
            'releaseManaged': True,
            'weeklyDigest': True,
            'color': '#0b8f87',
        }], week=WEEK_KEY)
        self.ensure(self.db)
        digest = self.digest(self.announcements())
        self.assertTrue(digest['active'])

    def test_released_digest_survives_rerun(self):
        self.ensure(self.db)
        self.ensure(self.db)
        self.assertFalse(self.digest(self.announcements())['active'])
        self.assertEqual(len(self.announcements()), 1)

    def test_manual_announcements_are_untouched(self):
        manual = {
            'id': 'ann-manual',
            'title': 'Comunicado da gestão',
            'description': 'texto',
            'date': date.today().isoformat(),
            'type': 'event',
            'active': True,
            'color': '#0b8f87',
        }
        self.put_state([manual], week=WEEK_KEY)
        self.ensure(self.db)
        saved = next(item for item in self.announcements() if item['id'] == 'ann-manual')
        self.assertTrue(saved['active'])
        self.assertNotIn('autoDraft', saved)


if __name__ == '__main__':
    unittest.main()
