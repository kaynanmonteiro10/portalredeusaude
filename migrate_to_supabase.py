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


def main():
    db = sqlite3.connect("portal.db")
    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    if not row:
        raise SystemExit("portal.db não possui portal_state")
    state = json.loads(row[0])
    request("portal_state", payload={"id": 1, "data": state})
    print(f"Estado migrado: {len(state.get('tasks', []))} demandas")
    print("Usuários e permissões devem ser migrados pelo administrador após configurar o backend.")


if __name__ == "__main__":
    main()
