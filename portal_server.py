import hashlib
import json
import mimetypes
import secrets
import socket
import ssl
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "portal.db"
HTTPS_PORT = 5443
HTTPS_CERT = ROOT / "portal-cert.pem"
HTTPS_KEY = ROOT / "portal-key.pem"
PBKDF2_ROUNDS = 120_000
SHARED_SCREENS = ("tasksScreen", "learningScreen")
DEFAULT_SECTOR_ID = "cadastro-faturamento"
DEFAULT_SECTOR_NAME = "Cadastro e Faturamento"
BUILTIN_SCREENS = (
    ("mergeScreen", "Mala Direta", DEFAULT_SECTOR_NAME, "Montar competências e histórico de cobranças."),
    ("boardScreen", "Quadro de Planilhas", DEFAULT_SECTOR_NAME, "Processamento de planilhas do sistema Python."),
    ("weeklyScreen", "Relatório Semanal", DEFAULT_SECTOR_NAME, "Cadastros da semana para envio à gerência."),
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), PBKDF2_ROUNDS).hex()
    return f"{salt}${digest}"


def verify_password(password, stored):
    try:
        salt, _digest = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(stored, hash_password(password, salt))


def connection():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute(
        "CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS screens (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('builtin', 'sector')),
            sector TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS user_screens (
            user_id TEXT NOT NULL,
            screen_id TEXT NOT NULL,
            PRIMARY KEY (user_id, screen_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (screen_id) REFERENCES screens(id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS sectors (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS user_sectors (
            user_id TEXT NOT NULL,
            sector_id TEXT NOT NULL,
            PRIMARY KEY (user_id, sector_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (sector_id) REFERENCES sectors(id)
        )"""
    )
    cols = {row[1] for row in db.execute("PRAGMA table_info(users)")}
    if "sector_id" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN sector_id TEXT")
    db.execute("INSERT OR IGNORE INTO user_sectors(user_id, sector_id) SELECT id, sector_id FROM users WHERE sector_id IS NOT NULL")
    db.commit()
    seed(db)
    return db


def seed(db):
    db.execute(
        "INSERT OR IGNORE INTO sectors(id, name, description, created_at) VALUES (?, ?, ?, ?)",
        (DEFAULT_SECTOR_ID, DEFAULT_SECTOR_NAME, "Cadastro e faturamento trabalham juntos no mesmo plantão.", now_iso()),
    )
    if db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0:
        admin_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (admin_id, "admin", "Administrador", hash_password("admin123"), "admin", None, now_iso()),
        )
    if not db.execute("SELECT 1 FROM users WHERE lower(username) = 'kaynan'").fetchone():
        db.execute(
            "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), "KAYNAN", "KAYNAN", hash_password("883816"), "admin", None, now_iso()),
        )
    for screen_id, name, sector, description in BUILTIN_SCREENS:
        db.execute(
            "INSERT OR IGNORE INTO screens(id, name, kind, sector, description, content, created_at) VALUES (?, ?, 'builtin', ?, ?, '{}', ?)",
            (screen_id, name, sector, description, now_iso()),
        )
    db.commit()


def sector_name(db, sector_id):
    if not sector_id:
        return ""
    row = db.execute("SELECT name FROM sectors WHERE id = ?", (sector_id,)).fetchone()
    return row["name"] if row else ""


def row_sector(row):
    return {"id": row["id"], "name": row["name"], "description": row["description"], "createdAt": row["created_at"]}


def row_user(db, user, include_screens=True):
    sector_id = user["sector_id"] if "sector_id" in user.keys() else None
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ? ORDER BY sector_id", (user["id"],))]
    if sector_id and sector_id not in sector_ids:
        sector_ids.insert(0, sector_id)
    sectors = [row_sector(row) for row in db.execute(f"SELECT * FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name", sector_ids)] if sector_ids else []
    payload = {
        "id": user["id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": user["role"],
        "sectorId": sector_id,
        "sectorName": sector_name(db, sector_id),
        "sectorIds": sector_ids,
        "sectors": sectors,
        "createdAt": user["created_at"],
    }
    if include_screens:
        screens = [row["screen_id"] for row in db.execute("SELECT screen_id FROM user_screens WHERE user_id = ?", (user["id"],))]
        payload["screens"] = sorted(set(screens))
        payload["allowedScreens"] = allowed_screens(user["role"], screens)
        if user["role"] != "admin" and sector_ids:
            payload["teammates"] = [
                {"id": row["id"], "displayName": row["display_name"], "sectorId": row["sector_id"]}
                for row in db.execute(
                    "SELECT DISTINCT u.id, u.display_name, u.sector_id FROM users u JOIN user_sectors us ON us.user_id = u.id WHERE us.sector_id IN ({}) AND u.id != ? ORDER BY u.display_name".format(','.join('?' for _ in sector_ids)),
                    (*sector_ids, user["id"]),
                )
            ]
        else:
            payload["teammates"] = [
                {"id": row["id"], "displayName": row["display_name"], "sectorId": row["sector_id"]}
                for row in db.execute("SELECT id, display_name, sector_id FROM users WHERE role = 'user' ORDER BY display_name")
            ]
    return payload


def filter_state_for_user(state, user, db):
    if user["role"] == "admin":
        return state
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
    if user["sector_id"] and user["sector_id"] not in sector_ids:
        sector_ids.append(user["sector_id"])
    tasks = state.get("tasks") or []
    state = dict(state)
    state["tasks"] = [task for task in tasks if isinstance(task, dict) and task.get("sectorId") in sector_ids]
    return state


def merge_state(existing, incoming, user, db):
    merged = dict(existing)
    for key in ("billingHistory", "mergeRows", "learningData"):
        if key in incoming:
            merged[key] = incoming[key]
    deleted_ids = set(existing.get("deletedTaskIds") or []) | set(incoming.get("deletedTaskIds") or [])
    incoming_tasks = incoming.get("tasks")
    if incoming_tasks is None:
        merged["deletedTaskIds"] = sorted(deleted_ids)
        return merged
    if user["role"] == "admin":
        existing_by_id = {str(task.get("id")): task for task in (existing.get("tasks") or []) if isinstance(task, dict) and task.get("id")}
        incoming_by_id = {str(task.get("id")): task for task in incoming_tasks if isinstance(task, dict) and task.get("id")}
        merged_tasks = []
        for task_id in set(existing_by_id) | set(incoming_by_id):
            if task_id in deleted_ids:
                continue
            old = existing_by_id.get(task_id)
            new = incoming_by_id.get(task_id)
            if old is None:
                chosen = new
            elif new is None:
                chosen = old
            else:
                old_stamp = str(old.get("updatedAt") or old.get("createdAt") or "")
                new_stamp = str(new.get("updatedAt") or new.get("createdAt") or "")
                chosen = new if new_stamp >= old_stamp else old
            if chosen:
                merged_tasks.append(chosen)
        merged["tasks"] = merged_tasks
        merged["deletedTaskIds"] = sorted(deleted_ids)
        return merged
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
    if user["sector_id"] and user["sector_id"] not in sector_ids:
        sector_ids.append(user["sector_id"])
    kept = [task for task in (existing.get("tasks") or []) if not (isinstance(task, dict) and task.get("sectorId") in sector_ids)]
    owned = []
    for task in incoming_tasks:
        if not isinstance(task, dict):
            continue
        item = dict(task)
        item["sectorId"] = item.get("sectorId") if item.get("sectorId") in sector_ids else (user["sector_id"] or (sector_ids[0] if sector_ids else None))
        owned.append(item)
    merged["tasks"] = kept + owned
    merged["deletedTaskIds"] = sorted(deleted_ids)
    return merged


def allowed_screens(role, assigned):
    extra = list(assigned)
    if role == "admin":
        return ["*"]
    return list(dict.fromkeys([*SHARED_SCREENS, *extra]))


def current_user(db, handler):
    header = handler.headers.get("Authorization", "")
    token = header.replace("Bearer ", "", 1).strip() if header.startswith("Bearer ") else ""
    if not token:
        return None
    row = db.execute(
        "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?",
        (token,),
    ).fetchone()
    return row


def require_user(db, handler):
    user = current_user(db, handler)
    if not user:
        handler.send_json({"error": "Entre com sua conta para continuar."}, 401)
    return user


def require_admin(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if user["role"] != "admin":
        handler.send_json({"error": "Somente o administrador pode fazer isso."}, 403)
        return None
    return user


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    return json.loads(handler.rfile.read(length).decode("utf-8") or "{}")


def set_user_screens(db, user_id, screen_ids):
    valid = {row["id"] for row in db.execute("SELECT id FROM screens")}
    db.execute("DELETE FROM user_screens WHERE user_id = ?", (user_id,))
    for screen_id in screen_ids or []:
        if screen_id in SHARED_SCREENS:
            continue
        if screen_id in valid:
            db.execute("INSERT OR IGNORE INTO user_screens(user_id, screen_id) VALUES (?, ?)", (user_id, screen_id))


def set_user_sectors(db, user_id, sector_ids, fallback=None):
    selected = list(dict.fromkeys(sector_ids or ([] if fallback is None else [fallback])))
    valid = {row["id"] for row in db.execute("SELECT id FROM sectors")}
    selected = [sector_id for sector_id in selected if sector_id in valid]
    db.execute("DELETE FROM user_sectors WHERE user_id = ?", (user_id,))
    for sector_id in selected:
        db.execute("INSERT INTO user_sectors(user_id, sector_id) VALUES (?, ?)", (user_id, sector_id))
    return selected


def screen_payload(row):
    try:
        content = json.loads(row["content"] or "{}")
    except json.JSONDecodeError:
        content = {}
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "sector": row["sector"],
        "description": row["description"],
        "content": content,
        "createdAt": row["created_at"],
    }


class PortalHandler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if user["role"] == "admin":
                    sector_rows = db.execute("SELECT * FROM sectors ORDER BY name").fetchall()
                elif user["sector_id"]:
                    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
                    if user["sector_id"] not in sector_ids:
                        sector_ids.insert(0, user["sector_id"])
                    sector_rows = db.execute(f"SELECT * FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name", sector_ids).fetchall()
                else:
                    sector_rows = []
                payload = {"user": row_user(db, user), "sectors": [row_sector(row) for row in sector_rows]}
                self.send_json(payload)
            return
        if path == "/api/sectors":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    sector_id = user["sector_id"] if "sector_id" in user.keys() else None
                    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
                    if sector_id and sector_id not in sector_ids:
                        sector_ids.insert(0, sector_id)
                    rows = db.execute(f"SELECT * FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name", sector_ids).fetchall() if sector_ids else []
                else:
                    rows = db.execute("SELECT * FROM sectors ORDER BY name").fetchall()
                self.send_json({"sectors": [row_sector(row) for row in rows]})
            return
        if path == "/api/users":
            with connection() as db:
                if not require_admin(db, self):
                    return
                users = [row_user(db, row) for row in db.execute("SELECT * FROM users ORDER BY created_at")]
            self.send_json({"users": users})
            return
        if path == "/api/screens":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                screens = [screen_payload(row) for row in db.execute("SELECT * FROM screens ORDER BY kind, name")]
                if user["role"] != "admin":
                    assigned = {row["screen_id"] for row in db.execute("SELECT screen_id FROM user_screens WHERE user_id = ?", (user["id"],))}
                    screens = [item for item in screens if item["id"] in assigned or item["id"] in SHARED_SCREENS]
            self.send_json({"screens": screens, "shared": list(SHARED_SCREENS)})
            return
        if path == "/api/state":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                state = json.loads(row["data"]) if row else {}
            self.send_json(filter_state_for_user(state, user, db))
            return
        if path == "/api/backup":
            with connection() as db:
                if not require_admin(db, self):
                    return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", "attachment; filename=portal.db")
            data = DB_PATH.read_bytes() if DB_PATH.exists() else b""
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.serve_file(self.path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = read_json(self)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "JSON inválido"}, 400)
            return
        if path == "/api/tasks/assign-sector":
            with connection() as db:
                if not require_admin(db, self):
                    return
                sector_id = str(payload.get("sectorId", "")).strip()
                if not db.execute("SELECT 1 FROM sectors WHERE id = ?", (sector_id,)).fetchone():
                    self.send_json({"error": "Setor não encontrado."}, 400)
                    return
                scope = payload.get("scope", "unassigned")
                if scope not in ("all", "unassigned"):
                    self.send_json({"error": "Escopo de atribuição inválido."}, 400)
                    return
                row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                state = json.loads(row["data"]) if row else {}
                tasks = state.get("tasks") or []
                updated = 0
                for task in tasks:
                    if isinstance(task, dict) and (scope == "all" or not task.get("sectorId")):
                        task["sectorId"] = sector_id
                        updated += 1
                state["tasks"] = tasks
                db.execute("INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP", (json.dumps(state, ensure_ascii=False),))
                db.commit()
                self.send_json({"updated": updated})
            return
        if path == "/api/login":
            username = str(payload.get("username", "")).strip().lower()
            password = str(payload.get("password", ""))
            with connection() as db:
                user = db.execute("SELECT * FROM users WHERE lower(username) = ?", (username,)).fetchone()
                if not user or not verify_password(password, user["password_hash"]):
                    self.send_json({"error": "Usuário ou senha incorretos."}, 401)
                    return
                token = secrets.token_hex(32)
                db.execute("INSERT INTO sessions(token, user_id, created_at) VALUES (?, ?, ?)", (token, user["id"], now_iso()))
                db.commit()
                self.send_json({"token": token, "user": row_user(db, user)})
            return
        if path == "/api/logout":
            header = self.headers.get("Authorization", "")
            token = header.replace("Bearer ", "", 1).strip() if header.startswith("Bearer ") else ""
            with connection() as db:
                if token:
                    db.execute("DELETE FROM sessions WHERE token = ?", (token,))
                    db.commit()
            self.send_json({"ok": True})
            return
        if path == "/api/users":
            with connection() as db:
                if not require_admin(db, self):
                    return
                username = str(payload.get("username", "")).strip().lower()
                display_name = str(payload.get("displayName", "")).strip()
                password = str(payload.get("password", ""))
                role = payload.get("role", "user")
                if role not in ("admin", "user") or not username or not display_name or len(password) < 4:
                    self.send_json({"error": "Informe nome, usuário e senha com pelo menos 4 caracteres."}, 400)
                    return
                if db.execute("SELECT 1 FROM users WHERE lower(username) = ?", (username,)).fetchone():
                    self.send_json({"error": "Este usuário já existe."}, 409)
                    return
                requested_sectors = payload.get("sectorIds") or ([payload.get("sectorId")] if payload.get("sectorId") else [])
                if role == "user" and not requested_sectors:
                    self.send_json({"error": "Escolha o setor desta conta."}, 400)
                    return
                sector_id = requested_sectors[0] if requested_sectors else None
                if role == "admin":
                    sector_id = None
                if any(not db.execute("SELECT 1 FROM sectors WHERE id = ?", (item,)).fetchone() for item in requested_sectors):
                    self.send_json({"error": "Setor não encontrado."}, 400)
                    return
                user_id = str(uuid.uuid4())
                db.execute(
                    "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user_id, username, display_name, hash_password(password), role, sector_id, now_iso()),
                )
                set_user_screens(db, user_id, payload.get("screens") or [])
                set_user_sectors(db, user_id, requested_sectors if role == "user" else [])
                db.commit()
                user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                self.send_json({"user": row_user(db, user)}, 201)
            return
        if path == "/api/sectors":
            with connection() as db:
                if not require_admin(db, self):
                    return
                name = str(payload.get("name", "")).strip()
                description = str(payload.get("description", "")).strip()
                if not name:
                    self.send_json({"error": "Informe o nome do setor."}, 400)
                    return
                if db.execute("SELECT 1 FROM sectors WHERE lower(name) = ?", (name.lower(),)).fetchone():
                    self.send_json({"error": "Este setor já existe."}, 409)
                    return
                sector_id = f"setor-{uuid.uuid4().hex[:10]}"
                db.execute(
                    "INSERT INTO sectors(id, name, description, created_at) VALUES (?, ?, ?, ?)",
                    (sector_id, name, description, now_iso()),
                )
                db.commit()
                row = db.execute("SELECT * FROM sectors WHERE id = ?", (sector_id,)).fetchone()
                self.send_json({"sector": row_sector(row)}, 201)
            return
        if path == "/api/screens":
            with connection() as db:
                if not require_admin(db, self):
                    return
                name = str(payload.get("name", "")).strip()
                sector_id = str(payload.get("sectorId", "")).strip()
                description = str(payload.get("description", "")).strip()
                sector_row = db.execute("SELECT * FROM sectors WHERE id = ?", (sector_id,)).fetchone() if sector_id else None
                if not name or not sector_row:
                    self.send_json({"error": "Informe o nome da tela e o setor."}, 400)
                    return
                screen_id = f"setor-{uuid.uuid4().hex[:10]}"
                db.execute(
                    "INSERT INTO screens(id, name, kind, sector, description, content, created_at) VALUES (?, ?, 'sector', ?, ?, ?, ?)",
                    (screen_id, name, sector_row["name"], description, json.dumps({"notes": "", "items": []}, ensure_ascii=False), now_iso()),
                )
                db.commit()
                row = db.execute("SELECT * FROM screens WHERE id = ?", (screen_id,)).fetchone()
                self.send_json({"screen": screen_payload(row)}, 201)
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            payload = read_json(self)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "JSON inválido"}, 400)
            return
        if path == "/api/state":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                existing = json.loads(row["data"]) if row else {}
                merged = merge_state(existing, payload, user, db)
                encoded = json.dumps(merged, ensure_ascii=False)
                db.execute(
                    "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
                    (encoded,),
                )
                db.commit()
            self.send_json({"saved": True})
            return
        if path.startswith("/api/users/"):
            user_id = unquote(path.split("/api/users/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                if not user:
                    self.send_json({"error": "Conta não encontrada."}, 404)
                    return
                display_name = str(payload.get("displayName", user["display_name"])).strip() or user["display_name"]
                role = payload.get("role", user["role"])
                if role not in ("admin", "user"):
                    self.send_json({"error": "Papel inválido."}, 400)
                    return
                if user["role"] == "admin" and role != "admin":
                    admins = db.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
                    if admins <= 1:
                        self.send_json({"error": "Precisa existir pelo menos um administrador."}, 400)
                        return
                current_sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user_id,))]
                requested_sectors = payload.get("sectorIds") or ([payload.get("sectorId")] if payload.get("sectorId") else current_sector_ids or ([user["sector_id"]] if user["sector_id"] else []))
                if role == "user" and not requested_sectors:
                    self.send_json({"error": "Escolha o setor desta conta."}, 400)
                    return
                sector_id = None if role == "admin" else requested_sectors[0]
                if any(not db.execute("SELECT 1 FROM sectors WHERE id = ?", (item,)).fetchone() for item in requested_sectors):
                    self.send_json({"error": "Setor não encontrado."}, 400)
                    return
                db.execute("UPDATE users SET display_name = ?, role = ?, sector_id = ? WHERE id = ?", (display_name, role, sector_id, user_id))
                set_user_sectors(db, user_id, requested_sectors if role == "user" else [])
                if payload.get("password"):
                    if len(str(payload["password"])) < 4:
                        self.send_json({"error": "A senha precisa ter pelo menos 4 caracteres."}, 400)
                        return
                    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(str(payload["password"])), user_id))
                    db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                if "screens" in payload:
                    set_user_screens(db, user_id, payload.get("screens") or [])
                db.commit()
                updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                self.send_json({"user": row_user(db, updated)})
            return
        if path.startswith("/api/screens/"):
            screen_id = unquote(path.split("/api/screens/", 1)[1])
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                screen = db.execute("SELECT * FROM screens WHERE id = ?", (screen_id,)).fetchone()
                if not screen:
                    self.send_json({"error": "Tela não encontrada."}, 404)
                    return
                assigned = {row["screen_id"] for row in db.execute("SELECT screen_id FROM user_screens WHERE user_id = ?", (user["id"],))}
                can_edit_content = user["role"] == "admin" or screen_id in assigned
                if not can_edit_content:
                    self.send_json({"error": "Você não tem acesso a esta tela."}, 403)
                    return
                name = screen["name"]
                sector = screen["sector"]
                description = screen["description"]
                content = screen["content"]
                if user["role"] == "admin":
                    name = str(payload.get("name", name)).strip() or name
                    sector = str(payload.get("sector", sector)).strip() or sector
                    description = str(payload.get("description", description)).strip()
                if "content" in payload:
                    content = json.dumps(payload.get("content") or {}, ensure_ascii=False)
                db.execute(
                    "UPDATE screens SET name = ?, sector = ?, description = ?, content = ? WHERE id = ?",
                    (name, sector, description, content, screen_id),
                )
                db.commit()
                updated = db.execute("SELECT * FROM screens WHERE id = ?", (screen_id,)).fetchone()
                self.send_json({"screen": screen_payload(updated)})
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/users/"):
            user_id = unquote(path.split("/api/users/", 1)[1])
            with connection() as db:
                admin = require_admin(db, self)
                if not admin:
                    return
                user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                if not user:
                    self.send_json({"error": "Conta não encontrada."}, 404)
                    return
                if user["id"] == admin["id"]:
                    self.send_json({"error": "Você não pode excluir a própria conta enquanto estiver logado."}, 400)
                    return
                if user["role"] == "admin":
                    admins = db.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
                    if admins <= 1:
                        self.send_json({"error": "Precisa existir pelo menos um administrador."}, 400)
                        return
                db.execute("DELETE FROM user_screens WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM users WHERE id = ?", (user_id,))
                db.commit()
            self.send_json({"deleted": True})
            return
        if path.startswith("/api/sectors/"):
            sector_id = unquote(path.split("/api/sectors/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                sector = db.execute("SELECT * FROM sectors WHERE id = ?", (sector_id,)).fetchone()
                if not sector:
                    self.send_json({"error": "Setor não encontrado."}, 404)
                    return
                if sector_id == DEFAULT_SECTOR_ID:
                    self.send_json({"error": "O setor Cadastro e Faturamento não pode ser excluído."}, 400)
                    return
                linked = db.execute("SELECT COUNT(*) AS n FROM users WHERE sector_id = ?", (sector_id,)).fetchone()["n"]
                if linked:
                    self.send_json({"error": "Há contas neste setor. Mova as pessoas antes de excluir."}, 400)
                    return
                db.execute("DELETE FROM sectors WHERE id = ?", (sector_id,))
                db.commit()
            self.send_json({"deleted": True})
            return
        if path.startswith("/api/screens/"):
            screen_id = unquote(path.split("/api/screens/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                screen = db.execute("SELECT * FROM screens WHERE id = ?", (screen_id,)).fetchone()
                if not screen:
                    self.send_json({"error": "Tela não encontrada."}, 404)
                    return
                if screen["kind"] == "builtin":
                    self.send_json({"error": "Telas nativas não podem ser excluídas. Basta não atribuí-las à conta."}, 400)
                    return
                db.execute("DELETE FROM user_screens WHERE screen_id = ?", (screen_id,))
                db.execute("DELETE FROM screens WHERE id = ?", (screen_id,))
                db.commit()
            self.send_json({"deleted": True})
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def serve_file(self, requested):
        relative = unquote(urlparse(requested).path.lstrip("/")) or "index.html"
        path = (ROOT / relative).resolve()
        if ROOT not in path.parents and path != ROOT:
            self.send_error(403)
            return
        if not path.is_file():
            self.send_error(404)
            return
        content = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        return


def ip_local():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    with connection():
        pass
    ip = ip_local()
    print("=" * 50, flush=True)
    print(f"Neste computador:      http://127.0.0.1:5500", flush=True)
    print(f"Nos outros aparelhos:  http://{ip}:5500", flush=True)
    print("=" * 50, flush=True)
    http_server = ThreadingHTTPServer(("0.0.0.0", 5500), PortalHandler)
    if HTTPS_CERT.exists() and HTTPS_KEY.exists():
        https_server = ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), PortalHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(HTTPS_CERT, HTTPS_KEY)
        https_server.socket = context.wrap_socket(https_server.socket, server_side=True)
        threading.Thread(target=https_server.serve_forever, daemon=True).start()
        print(f"HTTPS:                  https://{ip}:{HTTPS_PORT}", flush=True)
    http_server.serve_forever()
