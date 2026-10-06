import json
import os
import sqlite3
import urllib.request

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def request(table, method="POST", payload=None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates")
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def migrate_rows(table, rows):
    if rows:
        request(table, payload=rows)
        print(f"{table}: {len(rows)} registros")


def main():
    db = sqlite3.connect("portal.db")
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    if not row:
        raise SystemExit("portal.db não possui portal_state")
    state = json.loads(row[0])
    request("portal_state", payload={"id": 1, "data": state})
    print(f"Estado migrado: {len(state.get('tasks', []))} demandas")
    migrate_rows("sectors", [dict(item) for item in db.execute("SELECT id, name, description, created_at FROM sectors")])
    migrate_rows("users", [dict(item) for item in db.execute("SELECT id, username, display_name, password_hash, role, sector_id, created_at FROM users")])
    screens = []
    for item in db.execute("SELECT id, name, kind, sector, description, content, created_at FROM screens"):
        screen = dict(item)
        try:
            screen["content"] = json.loads(screen.get("content") or "{}")
        except json.JSONDecodeError:
            screen["content"] = {}
        screens.append(screen)
    migrate_rows("screens", screens)
    migrate_rows("user_screens", [dict(item) for item in db.execute("SELECT user_id, screen_id FROM user_screens")])
    migrate_rows("user_sectors", [dict(item) for item in db.execute("SELECT user_id, sector_id FROM user_sectors")])
    print("Sessões não foram migradas; todos precisarão entrar novamente.")


if __name__ == "__main__":
    main()
