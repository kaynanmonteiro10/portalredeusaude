import json
import tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import portal_server as portal


def main():
    with tempfile.TemporaryDirectory(prefix='portal-offline-test-') as folder:
        portal.DB_PATH = Path(folder) / 'test.db'
        portal.MEDIA_DIR = Path(folder) / 'media'
        with portal.connection() as db:
            db.execute('DELETE FROM sessions')
            db.execute('DELETE FROM user_screens')
            db.execute('DELETE FROM user_sectors')
            db.execute('DELETE FROM users')
            db.execute('INSERT INTO users(id,username,display_name,password_hash,role,sector_id,created_at) VALUES(?,?,?,?,?,?,?)',
                       ('offline-test-user', 'offline-test', 'Pessoa de teste', portal.hash_password('synthetic-only-test'), 'admin', None, portal.now_iso()))
            db.execute('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)', ('synthetic-browser-test', 'offline-test-user', portal.now_iso()))
            db.execute('INSERT OR REPLACE INTO portal_state(id,data) VALUES(1,?)', (json.dumps({'tasks': [], 'deletedTaskIds': []}),))
            db.commit()
        ThreadingHTTPServer(('127.0.0.1', 5511), portal.PortalHandler).serve_forever()


if __name__ == '__main__':
    main()
