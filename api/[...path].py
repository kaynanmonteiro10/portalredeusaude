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
    links = db_request("user_sectors", query={"user_id": f"eq.{user['id']}", "select": "sector_id"})
    sector_ids = list(dict.fromkeys([item["sector_id"] for item in links] + ([sector_id] if sector_id else [])))
    selected = [item for item in sectors if item["id"] in sector_ids]
    screen_links = db_request("user_screens", query={"user_id": f"eq.{user['id']}", "select": "screen_id"})
    screens = [item["screen_id"] for item in screen_links]
    allowed = ["*"] if user["role"] == "admin" else list(dict.fromkeys(["tasksScreen", "learningScreen", *screens]))
    teammates = db_request("users", query={"role": "eq.user", "select": "id,display_name,sector_id"})
    return {"id": user["id"], "username": user["username"], "displayName": user["display_name"], "role": user["role"], "sectorId": sector_id, "sectorName": selected[0]["name"] if selected else "", "sectorIds": sector_ids, "sectors": selected, "screens": screens, "allowedScreens": allowed, "teammates": [{"id": item["id"], "displayName": item["display_name"], "sectorId": item.get("sector_id")} for item in teammates if item["id"] != user["id"]]}


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
                users = db_request("users", query={"select": "*"})
                user = next((item for item in users if item["username"].lower() == username.lower()), None)
                if not user or not verify_password(str(payload.get("password", "")), user["password_hash"]):
                    return self.send_json({"error": "Usuário ou senha incorretos."}, 401)
                token = secrets.token_hex(32)
                db_request("sessions", "POST", payload={"token": token, "user_id": user["id"]})
                return self.send_json({"token": token, "user": user_payload(user)})
            if path == "/api/logout":
                token = self.headers.get("Authorization", "").replace("Bearer ", "", 1).strip()
                if token: db_request("sessions", "DELETE", query={"token": f"eq.{token}"})
                return self.send_json({"ok": True})
            user = current_user(self)
            if not user or user["role"] != "admin":
                return self.send_json({"error": "Somente o administrador pode fazer isso."}, 403)
            if path == "/api/users":
                username = str(payload.get("username", "")).strip()
                if not username or len(str(payload.get("password", ""))) < 4:
                    return self.send_json({"error": "Informe usuário e senha com pelo menos 4 caracteres."}, 400)
                if db_request("users", query={"username": f"eq.{urllib.parse.quote(username)}", "select": "id"}):
                    return self.send_json({"error": "Este usuário já existe."}, 409)
                user_id = str(uuid.uuid4())
                role = payload.get("role", "user")
                sectors = payload.get("sectorIds") or []
                db_request("users", "POST", payload={"id": user_id, "username": username, "display_name": str(payload.get("displayName", username)).strip(), "password_hash": hash_password(str(payload["password"])), "role": role, "sector_id": sectors[0] if sectors and role == "user" else None})
                for sector_id in sectors: db_request("user_sectors", "POST", payload={"user_id": user_id, "sector_id": sector_id})
                for screen_id in payload.get("screens", []): db_request("user_screens", "POST", payload={"user_id": user_id, "screen_id": screen_id})
                created = db_request("users", query={"id": f"eq.{user_id}", "select": "*"})[0]
                return self.send_json({"user": user_payload(created)}, 201)
            if path == "/api/sectors":
                name = str(payload.get("name", "")).strip()
                if not name: return self.send_json({"error": "Informe o nome do setor."}, 400)
                sector_id = f"setor-{uuid.uuid4().hex[:10]}"
                db_request("sectors", "POST", payload={"id": sector_id, "name": name, "description": str(payload.get("description", ""))})
                return self.send_json({"sector": db_request("sectors", query={"id": f"eq.{sector_id}", "select": "*"})[0]}, 201)
            if path == "/api/screens":
                screen_id = f"setor-{uuid.uuid4().hex[:10]}"
                sector_id = str(payload.get("sectorId", ""))
                sector = db_request("sectors", query={"id": f"eq.{sector_id}", "select": "name"})
                if not sector: return self.send_json({"error": "Setor não encontrado."}, 400)
                db_request("screens", "POST", payload={"id": screen_id, "name": str(payload.get("name", "")).strip(), "kind": "sector", "sector": sector[0]["name"], "description": str(payload.get("description", "")), "content": {"notes": "", "items": []}})
                return self.send_json({"screen": db_request("screens", query={"id": f"eq.{screen_id}", "select": "*"})[0]}, 201)
            if path == "/api/tasks/assign-sector":
                state = read_state(); sector_id = str(payload.get("sectorId", "")); scope = payload.get("scope", "unassigned"); updated = 0
                for task in state.get("tasks", []):
                    if scope == "all" or not task.get("sectorId"):
                        task["sectorId"] = sector_id; updated += 1
                state["tasks"] = state.get("tasks", []); db_request("portal_state", "PATCH", query={"id": "eq.1"}, payload={"data": state, "updated_at": now_iso()})
                return self.send_json({"updated": updated})
            return self.send_json({"error": "Rota não encontrada"}, 404)
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def do_PUT(self):
        try:
            path = urllib.parse.urlparse(self.path).path
            user = current_user(self)
            if not user: return self.send_json({"error": "Entre com sua conta para continuar."}, 401)
            if path == "/api/state":
                merged = merge_state(read_state(), self.body())
                rows = db_request("portal_state", query={"id": "eq.1", "select": "id"})
                if rows: db_request("portal_state", "PATCH", query={"id": "eq.1"}, payload={"data": merged, "updated_at": now_iso()})
                else: db_request("portal_state", "POST", payload={"id": 1, "data": merged})
                return self.send_json({"saved": True})
            if user["role"] != "admin": return self.send_json({"error": "Somente o administrador pode fazer isso."}, 403)
            payload = self.body()
            if path.startswith("/api/users/"):
                user_id = path.rsplit("/", 1)[1]
                changes = {"display_name": str(payload.get("displayName", "")).strip(), "role": payload.get("role", "user"), "sector_id": (payload.get("sectorIds") or [None])[0]}
                if payload.get("password"): changes["password_hash"] = hash_password(str(payload["password"]))
                db_request("users", "PATCH", query={"id": f"eq.{user_id}"}, payload=changes)
                db_request("user_sectors", "DELETE", query={"user_id": f"eq.{user_id}"})
                db_request("user_screens", "DELETE", query={"user_id": f"eq.{user_id}"})
                for sector_id in payload.get("sectorIds", []): db_request("user_sectors", "POST", payload={"user_id": user_id, "sector_id": sector_id})
                for screen_id in payload.get("screens", []): db_request("user_screens", "POST", payload={"user_id": user_id, "screen_id": screen_id})
                return self.send_json({"user": user_payload(db_request("users", query={"id": f"eq.{user_id}", "select": "*"})[0])})
            if path.startswith("/api/screens/"):
                screen_id = path.rsplit("/", 1)[1]
                db_request("screens", "PATCH", query={"id": f"eq.{screen_id}"}, payload={"content": payload.get("content") or {}})
                return self.send_json({"screen": db_request("screens", query={"id": f"eq.{screen_id}", "select": "*"})[0]})
            return self.send_json({"error": "Rota não encontrada"}, 404)
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def do_DELETE(self):
        try:
            user = current_user(self)
            if not user or user["role"] != "admin": return self.send_json({"error": "Somente o administrador pode fazer isso."}, 403)
            path = urllib.parse.urlparse(self.path).path
            resource, item_id = path.split("/api/", 1)[1].split("/", 1)
            table = {"users": "users", "sectors": "sectors", "screens": "screens"}.get(resource)
            if not table: return self.send_json({"error": "Rota não encontrada"}, 404)
            db_request(table, "DELETE", query={"id": f"eq.{item_id}"})
            return self.send_json({"deleted": True})
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)
