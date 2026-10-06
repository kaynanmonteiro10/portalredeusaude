import base64
import hashlib
import json
import os
import secrets
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://bhkqeulrcrnthvdafigy.supabase.co").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
DEFAULT_SECTOR_ID = "cadastro-faturamento"
DEFAULT_SECTOR_NAME = "Cadastro e Faturamento"
BUILTIN_SCREENS = (
    ("mergeScreen", "Mala Direta", "Cadastro e Faturamento", "Montar competências e histórico de cobranças."),
    ("boardScreen", "Quadro de Planilhas", "Cadastro e Faturamento", "Processamento de planilhas do sistema Python."),
    ("weeklyScreen", "Relatório Semanal", "Cadastro e Faturamento", "Cadastros da semana para envio à gerência."),
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${digest}"


def verify_password(password, stored):
    try:
        salt, digest = stored.split("$", 1)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return secrets.compare_digest(actual, digest)


def db_request(table, method="GET", query=None, payload=None):
    if not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY não configurada")
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("apikey", SUPABASE_KEY)
    request.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read()
        return json.loads(raw.decode()) if raw else []


def ensure_seed():
    sectors = db_request("sectors", query={"id": f"eq.{DEFAULT_SECTOR_ID}", "select": "id"})
    if not sectors:
        db_request("sectors", "POST", payload={"id": DEFAULT_SECTOR_ID, "name": DEFAULT_SECTOR_NAME, "description": "Cadastro e faturamento trabalham juntos no mesmo plantão."})
    if not db_request("users", query={"username": "eq.admin", "select": "id"}):
        db_request("users", "POST", payload={"id": str(uuid.uuid4()), "username": "admin", "display_name": "Administrador", "password_hash": hash_password("admin123"), "role": "admin"})
    if not db_request("users", query={"username": "eq.KAYNAN", "select": "id"}):
        db_request("users", "POST", payload={"id": str(uuid.uuid4()), "username": "KAYNAN", "display_name": "KAYNAN", "password_hash": hash_password("883816"), "role": "admin"})
    for screen_id, name, sector, description in BUILTIN_SCREENS:
        if not db_request("screens", query={"id": f"eq.{screen_id}", "select": "id"}):
            db_request("screens", "POST", payload={"id": screen_id, "name": name, "kind": "builtin", "sector": sector, "description": description, "content": {}})


def current_user(handler):
    token = handler.headers.get("Authorization", "").replace("Bearer ", "", 1).strip()
    if not token:
        return None
    rows = db_request("sessions", query={"token": f"eq.{token}", "select": "user_id"})
    if not rows:
        return None
    users = db_request("users", query={"id": f"eq.{rows[0]['user_id']}", "select": "*"})
    return users[0] if users else None


def user_payload(user):
    sector_id = user.get("sector_id")
    sectors = db_request("sectors", query={"select": "*", "order": "name.asc"})
    selected = [item for item in sectors if item["id"] == sector_id] if sector_id else []
    return {"id": user["id"], "username": user["username"], "displayName": user["display_name"], "role": user["role"], "sectorId": sector_id, "sectorName": selected[0]["name"] if selected else "", "sectorIds": [item["id"] for item in selected], "sectors": selected, "screens": [], "allowedScreens": ["*"] if user["role"] == "admin" else ["tasksScreen", "learningScreen"], "teammates": []}


def read_state():
    rows = db_request("portal_state", query={"id": "eq.1", "select": "data"})
    return rows[0]["data"] if rows else {}


def merge_state(existing, incoming):
    deleted = set(existing.get("deletedTaskIds", [])) | set(incoming.get("deletedTaskIds", []))
    old = {str(item.get("id")): item for item in existing.get("tasks", []) if item.get("id")}
    new = {str(item.get("id")): item for item in incoming.get("tasks", []) if item.get("id")}
    tasks = []
    for task_id in set(old) | set(new):
        if task_id in deleted:
            continue
        left, right = old.get(task_id), new.get(task_id)
        if not left:
            chosen = right
        elif not right:
            chosen = left
        else:
            chosen = right if str(right.get("updatedAt", right.get("createdAt", ""))) >= str(left.get("updatedAt", left.get("createdAt", ""))) else left
        if chosen:
            tasks.append(chosen)
    merged = dict(existing)
    merged.update({key: incoming[key] for key in ("billingHistory", "mergeRows", "learningData") if key in incoming})
    merged["tasks"] = tasks
    merged["deletedTaskIds"] = sorted(deleted)
    return merged


class handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length).decode() or "{}")

    def do_GET(self):
        try:
            ensure_seed()
            path = urllib.parse.urlparse(self.path).path
            user = current_user(self)
            if path == "/api/me":
                if not user: return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
                return self.send_json({"user": user_payload(user)})
            if path == "/api/state":
                if not user: return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
                return self.send_json(read_state())
            if path == "/api/screens":
                if not user: return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
                return self.send_json({"screens": db_request("screens", query={"select": "*", "order": "kind.asc,name.asc"}), "shared": ["tasksScreen", "learningScreen"]})
            if path == "/api/sectors":
                if not user: return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
                return self.send_json({"sectors": db_request("sectors", query={"select": "*", "order": "name.asc"})})
            if path == "/api/users":
                if not user or user["role"] != "admin": return self.send_json({"error": "Somente o administrador pode fazer isso."}, 403)
                return self.send_json({"users": [user_payload(item) for item in db_request("users", query={"select": "*", "order": "created_at.asc"})]})
            return self.send_json({"error": "Rota não encontrada"}, 404)
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def do_POST(self):
        try:
            payload = self.body()
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/login":
                ensure_seed()
                username = str(payload.get("username", "")).strip()
                users = db_request("users", query={"username": f"eq.{urllib.parse.quote(username.lower())}", "select": "*"})
                if not users or not verify_password(str(payload.get("password", "")), users[0]["password_hash"]):
                    return self.send_json({"error": "Usuário ou senha incorretos."}, 401)
                token = secrets.token_hex(32)
                db_request("sessions", "POST", payload={"token": token, "user_id": users[0]["id"]})
                return self.send_json({"token": token, "user": user_payload(users[0])})
            if path == "/api/logout":
                token = self.headers.get("Authorization", "").replace("Bearer ", "", 1).strip()
                if token: db_request("sessions", "DELETE", query={"token": f"eq.{token}"})
                return self.send_json({"ok": True})
            return self.send_json({"error": "Rota não encontrada"}, 404)
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def do_PUT(self):
        try:
            if urllib.parse.urlparse(self.path).path != "/api/state": return self.send_json({"error": "Rota não encontrada"}, 404)
            if not current_user(self): return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
            merged = merge_state(read_state(), self.body())
            rows = db_request("portal_state", query={"id": "eq.1", "select": "id"})
            if rows: db_request("portal_state", "PATCH", query={"id": "eq.1"}, payload={"data": merged, "updated_at": now_iso()})
            else: db_request("portal_state", "POST", payload={"id": 1, "data": merged})
            return self.send_json({"saved": True})
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)
