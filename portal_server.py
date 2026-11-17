import base64
import calendar
import csv
import hashlib
import io
import json
import mimetypes
import re
import secrets
import shutil
import smtplib
import socket
import ssl
import sqlite3
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse

import os
import sys

# O Python embarcado da pasta runtime não adiciona a pasta do script ao sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsx_simple
import s4e_connector as s4e
import retornos
import vendas
import vidas
import s4e_notas
import task_sync
import recibos_pdf
import relatorio_semanal

mimetypes.add_type("application/x-chrome-extension", ".crx")

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "portal.db"
MEDIA_DIR = ROOT / "media"
# Pastas e arquivos que nunca devem ser entregues como arquivo estático:
# a chave do HTTPS, o banco, o código e os backups ficam fora do alcance do navegador.
STATIC_BLOCKED_DIRS = {"__pycache__", ".git", ".venv", ".eucode", "api", "supabase", "_internal", "runtime", "react-src", "apuracao", "recibos"}
STATIC_BLOCKED_SUFFIXES = {
    ".pem", ".key", ".db", ".bak", ".log", ".py", ".pyc", ".pyd", ".mjs", ".sql",
    ".yml", ".yaml", ".ini", ".md", ".json", ".env", ".bat", ".ps1", ".sh", ".cfg", ".toml",
}
STATIC_BLOCKED_NAMES = {"dockerfile", "desktop.ini"}


def is_private_static(relative: Path) -> bool:
    parts = relative.parts
    if not parts:
        return False
    if any(part.lower() in STATIC_BLOCKED_DIRS or part.startswith(".") for part in parts[:-1]):
        return True
    name = parts[-1].lower()
    if name.startswith(".") or name.startswith("qa_"):
        return True
    if name in STATIC_BLOCKED_NAMES or name.startswith("portal.db"):
        return True
    return relative.suffix.lower() in STATIC_BLOCKED_SUFFIXES


def _dpapi(data, protect):
    import ctypes
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buffer = ctypes.create_string_buffer(data, len(data))
    source = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    result = DataBlob()
    crypt32 = ctypes.windll.crypt32
    args = (ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result))
    ok = crypt32.CryptProtectData(*args) if protect else crypt32.CryptUnprotectData(*args)
    if not ok:
        raise OSError("O Windows não conseguiu proteger o segredo (DPAPI).")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(result.pbData)


MEDIA_LIMITS = {"image": 8_000_000, "video": 40_000_000, "audio": 20_000_000, "file": 20_000_000}
DOC_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".txt", ".csv", ".rtf", ".odt", ".ods", ".odp", ".json", ".xml",
    ".zip", ".rar", ".7z",
}
MEDIA_TYPES = {
    "image/jpeg": ("image", ".jpg"),
    "image/png": ("image", ".png"),
    "image/webp": ("image", ".webp"),
    "image/gif": ("image", ".gif"),
    "video/mp4": ("video", ".mp4"),
    "video/webm": ("video", ".webm"),
    "video/ogg": ("video", ".ogv"),
    "video/quicktime": ("video", ".mov"),
    "audio/webm": ("audio", ".weba"),
    "audio/ogg": ("audio", ".oga"),
    "audio/mp4": ("audio", ".m4a"),
    "audio/mpeg": ("audio", ".mp3"),
    "audio/wav": ("audio", ".wav"),
    "audio/x-m4a": ("audio", ".m4a"),
}
INLINE_MEDIA_SUFFIXES = {suffix for _, suffix in MEDIA_TYPES.values()}
HTTPS_PORT = 5443
HTTPS_CERT = ROOT / "portal-cert.pem"
HTTPS_KEY = ROOT / "portal-key.pem"
PBKDF2_ROUNDS = 120_000
SHARED_SCREENS = ("homeScreen", "tasksScreen", "birthdaysScreen", "chatScreen", "feedScreen", "learningScreen")
DISABLED_SCREENS = {"managementScreen", "mergeScreen", "boardScreen"}
DEFAULT_SECTOR_ID = "cadastro-faturamento"
DEFAULT_SECTOR_NAME = "Cadastro e Faturamento"
BUILTIN_SCREENS = (
    ("tasksScreen",      "Demandas", "Geral",               "Demandas do setor com prioridades, prazos e calendário."),
    ("learningScreen",   "Treinamentos do Setor", "Geral",             "Trilhas de treinamento e biblioteca de conteúdos do setor."),
    ("reportsScreen",    "Relatórios",       "Geral",                  "Relatório de operação e acompanhamento de demandas."),
    ("managementScreen", "Painel da Gestão", "Gerência",               "Visão gerencial de todos os setores."),
    ("mergeScreen",      "Mala Direta",      DEFAULT_SECTOR_NAME,      "Montar competências e histórico de cobranças."),
    ("boardScreen",      "Quadro de Planilhas", DEFAULT_SECTOR_NAME,   "Processamento de planilhas do sistema Python."),
    ("weeklyScreen",     "Relatório Semanal",   DEFAULT_SECTOR_NAME,   "Cadastros da semana para envio à gerência."),
    ("sindicatosScreen", "Sindicatos",           DEFAULT_SECTOR_NAME,   "Consulta de CCT e ACT da Rede Saúde."),
    ("contractsScreen",  "Contratos",            DEFAULT_SECTOR_NAME,   "Empresas e vidas importadas por planilha, com histórico de importações."),
    ("vendasScreen",     "Acompanhamento de Vendas", DEFAULT_SECTOR_NAME, "Consulta administrativa de vendas do S4E e vínculos confirmados com contratos."),
    ("vidasScreen",      "Movimentação de Vidas", DEFAULT_SECTOR_NAME, "Vidas que entraram e saíram no período, por centro de custo e grupo, com comparativo da carteira."),
    ("commissionsScreen", "Comissões",           DEFAULT_SECTOR_NAME,   "Contratos do vendedor, movimentações e comissões com valores protegidos."),
    ("financeScreen",    "Rateios P4X",          DEFAULT_SECTOR_NAME,   "Rateios recebidos do P4X com filtros, totais e exportação consolidada."),
    ("retornosScreen",   "Retorno Instituição",  DEFAULT_SECTOR_NAME,   "Erros e correções confirmadas dos retornos das instituições financeiras."),
    ("cobrancaScreen",   "Cobrança",             DEFAULT_SECTOR_NAME,   "Fila de mensalidades e acordos em atraso com e-mail e WhatsApp prontos."),
    ("apuracaoScreen",   "Apuração",             DEFAULT_SECTOR_NAME,   "Telão de apuração mensal: empresas totais e pagas por grupo, com planilha automática."),
    ("rateioScreen",     "Rateio de Faturamento", DEFAULT_SECTOR_NAME,  "Regras salvas por grupo para dividir o faturamento mensal."),
    ("recibosScreen",    "Recibos",              DEFAULT_SECTOR_NAME,   "Recibos em PDF das empresas que pagaram, organizados por grupo, sindicato e empresa."),
    ("adesiScreen",      "Conferência de Adesões", DEFAULT_SECTOR_NAME,   "Verificação de adesões importadas com status de conferência e validação automática."),
    ("birthdaysScreen",  "Aniversariantes",      "Geral",               "Quem faz aniversário e quando é a próxima comemoração do setor."),
    ("chatScreen",       "Conversas",            "Geral",               "Chat da equipe, canais por setor, pessoas e grupos."),
    ("feedScreen",       "Mural da Equipe",      "Geral",               "Fotos de eventos, avisos e novidades publicadas pela equipe."),
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def today_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def normalize_birthday(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return None


def next_anniversary(month, day, year=None):
    today = date.today()

    def anniversary(target_year):
        try:
            return date(target_year, month, day)
        except ValueError:
            return date(target_year, 3, 1)

    candidate = anniversary(today.year)
    if candidate < today:
        candidate = anniversary(today.year + 1)
    days_until = (candidate - today).days
    age = candidate.year - year if year else None
    return candidate, days_until, age


def birthday_iso(month, day, year=None):
    return f"{year:04d}-{month:02d}-{day:02d}" if year else None


def birthday_parts(payload, fallback=None):
    source = fallback or {}
    raw_day = payload.get("day", source.get("day"))
    raw_month = payload.get("month", source.get("month"))
    raw_year = payload.get("year", source.get("year"))
    try:
        day = int(raw_day)
        month = int(raw_month)
    except (TypeError, ValueError):
        return None
    year = None
    if str(raw_year or "").strip():
        try:
            year = int(raw_year)
        except (TypeError, ValueError):
            return None
        if not 1900 <= year <= date.today().year:
            return None
    try:
        date(2000, month, day)
    except ValueError:
        return None
    return month, day, year


def normalize_photo(value):
    """None = sem foto, False = inválida, str = data URL aceita."""
    raw = str(value or "").strip()
    if not raw:
        return None
    if not raw.startswith("data:image/") or len(raw) > 900_000:
        return False
    return raw


# id, mês, dia, ano, tipo, observação, nome da conta para vincular, nome exibido
BIRTHDAY_SEED = (
    ("bd-01-04-cavaleiro", 1, 4, None, "team", "", None, "Cavaleiro"),
    ("bd-01-06-cassio-cacau", 1, 6, None, "team", "", None, "Cássio Cacau"),
    ("bd-02-07-diego", 2, 7, None, "team", "", None, "Diego"),
    ("bd-02-22-pedro", 2, 22, None, "team", "", "Pedro", "Pedro"),
    ("bd-03-07-rita", 3, 7, None, "team", "", "RITA DE CASSIA", "Rita de Cássia"),
    ("bd-03-30-monalisa", 3, 30, None, "team", "", "Monalisa", "Monalisa"),
    ("bd-04-14-kaila", 4, 14, None, "team", "", "Kaila", "Kaila"),
    ("bd-05-08-yanca", 5, 8, None, "team", "", "Yanca", "Yanca"),
    ("bd-05-17-juliana", 5, 17, None, "team", "", "Juliana", "Juliana"),
    ("bd-05-19-david", 5, 19, None, "team", "", "David", "David"),
    ("bd-05-19-simone", 5, 19, None, "team", "", "Simone", "Simone"),
    ("bd-05-20-kildery", 5, 20, None, "team", "", None, "Kildery"),
    ("bd-05-24-henrique", 5, 24, None, "team", "", None, "Henrique"),
    ("bd-06-05-tiago", 6, 5, None, "team", "", None, "Tiago"),
    ("bd-07-15-christiano", 7, 15, None, "team", "", None, "Christiano"),
    ("bd-07-16-kaynan", 7, 16, None, "team", "", None, "Kaynan"),
    ("bd-07-30-lilia", 7, 30, None, "team", "", None, "Lilia"),
    ("bd-09-04-elaine", 9, 4, None, "team", "", None, "Elaine"),
    ("bd-09-05-ray", 9, 5, None, "team", "", None, "Ray"),
    ("bd-09-22-farias", 9, 22, None, "team", "", None, "Farias"),
    ("bd-09-29-ana-carla", 9, 29, None, "team", "", None, "Ana Carla"),
    ("bd-11-23-rosemary", 11, 23, None, "team", "", None, "Rosemary"),
    ("bd-11-23-camila", 11, 23, None, "team", "", "Camila", "Camila"),
    ("bd-12-07-bira-salek", 12, 7, None, "team", "", None, "Bira Salek"),
    ("bd-12-27-rafael-cacau", 12, 27, None, "team", "", None, "Rafael Cacau"),
    ("bd-02-04-luciana", 2, 4, None, "partner", "Primavida", None, "Luciana"),
    ("bd-02-06-thayany", 2, 6, None, "partner", "", None, "Thayany"),
    ("bd-02-22-alessandro", 2, 22, None, "partner", "", None, "Alessandro"),
    ("bd-05-02-ricardo", 5, 2, None, "partner", "", None, "Ricardo"),
    ("bd-05-04-ione", 5, 4, None, "partner", "", None, "Ione"),
    ("bd-10-25-betao", 10, 25, None, "partner", "", None, "Betão"),
    ("bd-11-26-almir", 11, 26, None, "partner", "", None, "Almir"),
    ("bd-12-11-bia", 12, 11, None, "partner", "", None, "Bia"),
)


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
    MEDIA_DIR.mkdir(exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 30000")
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
    cols = {row[1] for row in db.execute("PRAGMA table_info(users)")}
    if "last_login" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN last_login TEXT")
    if "management" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN management INTEGER NOT NULL DEFAULT 0")
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
        """CREATE TABLE IF NOT EXISTS portal_agent_events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            screen TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
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
    if "birthday" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN birthday TEXT")
    if "photo" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN photo TEXT")
    if "seller_name" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN seller_name TEXT NOT NULL DEFAULT ''")
    if "active" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    if "status_emoji" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN status_emoji TEXT NOT NULL DEFAULT ''")
    if "status_text" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT ''")
    if "status_until" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN status_until TEXT NOT NULL DEFAULT ''")
    cols = {row[1] for row in db.execute("PRAGMA table_info(users)")}
    if "works_saturday" not in cols or "works_sunday" not in cols:
        if "works_saturday" not in cols:
            db.execute("ALTER TABLE users ADD COLUMN works_saturday INTEGER NOT NULL DEFAULT 0")
        if "works_sunday" not in cols:
            db.execute("ALTER TABLE users ADD COLUMN works_sunday INTEGER NOT NULL DEFAULT 0")
        seed_weekend_schedule(db)
    db.execute(
        """CREATE TABLE IF NOT EXISTS birthdays (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            name TEXT NOT NULL,
            day INTEGER NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER,
            kind TEXT NOT NULL DEFAULT 'team',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    bd_cols = {row[1] for row in db.execute("PRAGMA table_info(birthdays)")}
    if "photo" not in bd_cols:
        db.execute("ALTER TABLE birthdays ADD COLUMN photo TEXT")
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL CHECK (scope IN ('team', 'sector', 'direct')),
            scope_id TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS chat_messages_scope ON chat_messages(scope, scope_id, created_at)")
    chat_cols = {row[1] for row in db.execute("PRAGMA table_info(chat_messages)")}
    for column, definition in (
        ("kind", "TEXT NOT NULL DEFAULT 'text'"),
        ("media_id", "TEXT NOT NULL DEFAULT ''"),
        ("media_mime", "TEXT NOT NULL DEFAULT ''"),
        ("media_name", "TEXT NOT NULL DEFAULT ''"),
        ("media_size", "INTEGER NOT NULL DEFAULT 0"),
        ("media_duration", "REAL NOT NULL DEFAULT 0"),
    ):
        if column not in chat_cols:
            db.execute(f"ALTER TABLE chat_messages ADD COLUMN {column} {definition}")
    db.execute(
        """CREATE TABLE IF NOT EXISTS chat_reads (
            user_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            scope_id TEXT NOT NULL DEFAULT '',
            last_read_at TEXT NOT NULL,
            PRIMARY KEY (user_id, scope, scope_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_posts (
            id TEXT PRIMARY KEY,
            author_id TEXT,
            kind TEXT NOT NULL DEFAULT 'post',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            meta TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_media (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            media TEXT NOT NULL,
            mime TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (post_id) REFERENCES feed_posts(id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_likes (
            post_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (post_id, user_id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_comments (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (post_id) REFERENCES feed_posts(id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_reads (
            post_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            seen_at TEXT NOT NULL,
            PRIMARY KEY (post_id, user_id)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS feed_notices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            post_id TEXT,
            post_title TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            seen_at TEXT
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS system_updates (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    comment_cols = {row[1] for row in db.execute("PRAGMA table_info(feed_comments)")}
    if "parent_id" not in comment_cols:
        db.execute("ALTER TABLE feed_comments ADD COLUMN parent_id TEXT")
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_companies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cnpj TEXT NOT NULL DEFAULT '',
            cnpj_key TEXT NOT NULL DEFAULT '',
            contact_name TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            accountant_name TEXT NOT NULL DEFAULT '',
            accountant_email TEXT NOT NULL DEFAULT '',
            plan TEXT NOT NULL DEFAULT '',
            monthly_value REAL NOT NULL DEFAULT 0,
            seller TEXT NOT NULL DEFAULT '',
            contract_start TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ativo',
            notes TEXT NOT NULL DEFAULT '',
            source_file TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            imported_at TEXT NOT NULL DEFAULT ''
        )"""
    )
    company_cols = {row[1] for row in db.execute("PRAGMA table_info(contract_companies)")}
    for column, definition in (
        ("client_type", "TEXT NOT NULL DEFAULT 'Empresa'"),
        ("value_per_life", "REAL NOT NULL DEFAULT 0"),
        ("initial_lives", "INTEGER NOT NULL DEFAULT 0"),
        ("registered", "INTEGER NOT NULL DEFAULT 0"),
        ("registered_at", "TEXT NOT NULL DEFAULT ''"),
        ("registered_by", "TEXT NOT NULL DEFAULT ''"),
    ):
        if column not in company_cols:
            db.execute(f"ALTER TABLE contract_companies ADD COLUMN {column} {definition}")
    db.execute("CREATE INDEX IF NOT EXISTS contract_companies_cnpj ON contract_companies(cnpj_key)")
    db.execute("CREATE INDEX IF NOT EXISTS contract_companies_name ON contract_companies(name)")
    ensure_contract_events_schema(db)
    ensure_contract_registration_schema(db)
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_movements (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            month_number INTEGER NOT NULL DEFAULT 1,
            lives_added INTEGER NOT NULL DEFAULT 0,
            value_per_life REAL NOT NULL DEFAULT 0,
            total_month REAL NOT NULL DEFAULT 0,
            commission REAL NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (company_id) REFERENCES contract_companies(id) ON DELETE CASCADE
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS contract_movements_company ON contract_movements(company_id)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_lives (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            name TEXT NOT NULL,
            cpf TEXT NOT NULL DEFAULT '',
            cpf_key TEXT NOT NULL DEFAULT '',
            birth_date TEXT NOT NULL DEFAULT '',
            mother_name TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (company_id) REFERENCES contract_companies(id) ON DELETE CASCADE
        )"""
    )
    life_cols = {row[1] for row in db.execute("PRAGMA table_info(contract_lives)")}
    if "registered" not in life_cols:
        db.execute("ALTER TABLE contract_lives ADD COLUMN registered INTEGER NOT NULL DEFAULT 0")
    db.execute("CREATE INDEX IF NOT EXISTS contract_lives_company ON contract_lives(company_id)")
    db.execute("CREATE INDEX IF NOT EXISTS contract_lives_cpf ON contract_lives(cpf_key)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_imports (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL DEFAULT '',
            company_name TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            user_name TEXT NOT NULL DEFAULT '',
            companies_created INTEGER NOT NULL DEFAULT 0,
            companies_updated INTEGER NOT NULL DEFAULT 0,
            lives_created INTEGER NOT NULL DEFAULT 0,
            lives_updated INTEGER NOT NULL DEFAULT 0,
            lives_removed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS finance_imports (
            id TEXT PRIMARY KEY,
            file_name TEXT NOT NULL DEFAULT '',
            file_hash TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            user_name TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'planilha',
            rows_count INTEGER NOT NULL DEFAULT 0,
            files_count INTEGER NOT NULL DEFAULT 0,
            receivers_count INTEGER NOT NULL DEFAULT 0,
            total_nominal REAL NOT NULL DEFAULT 0,
            total_fee REAL NOT NULL DEFAULT 0,
            total_paid REAL NOT NULL DEFAULT 0,
            total_rateio REAL NOT NULL DEFAULT 0,
            period_start TEXT NOT NULL DEFAULT '',
            period_end TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS finance_rateios (
            id TEXT PRIMARY KEY,
            import_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT '',
            receiver_name TEXT NOT NULL DEFAULT '',
            receiver_doc TEXT NOT NULL DEFAULT '',
            occurrence TEXT NOT NULL DEFAULT '',
            occurrence_code TEXT NOT NULL DEFAULT '',
            payer_name TEXT NOT NULL DEFAULT '',
            payer_doc TEXT NOT NULL DEFAULT '',
            our_number TEXT NOT NULL DEFAULT '',
            your_number TEXT NOT NULL DEFAULT '',
            nominal REAL NOT NULL DEFAULT 0,
            fee REAL NOT NULL DEFAULT 0,
            paid REAL NOT NULL DEFAULT 0,
            rateio REAL NOT NULL DEFAULT 0,
            due_date TEXT NOT NULL DEFAULT '',
            payment_date TEXT NOT NULL DEFAULT '',
            credit_date TEXT NOT NULL DEFAULT '',
            rateio_date TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS finance_rateios_import ON finance_rateios(import_id)")
    db.execute("CREATE INDEX IF NOT EXISTS finance_rateios_payment ON finance_rateios(payment_date)")
    db.execute("CREATE INDEX IF NOT EXISTS finance_rateios_file ON finance_rateios(file_name)")
    db.execute("CREATE INDEX IF NOT EXISTS finance_rateios_receiver ON finance_rateios(receiver_name)")
    db.execute("CREATE INDEX IF NOT EXISTS finance_imports_hash ON finance_imports(file_hash)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS cobranca_cases (
            id TEXT PRIMARY KEY,
            case_key TEXT UNIQUE NOT NULL,
            cliente TEXT NOT NULL DEFAULT '',
            documento TEXT NOT NULL DEFAULT '',
            empresa TEXT NOT NULL DEFAULT '',
            grupo TEXT NOT NULL DEFAULT '',
            departamento TEXT NOT NULL DEFAULT '',
            cd_associado TEXT NOT NULL DEFAULT '',
            tipo_parcela TEXT NOT NULL DEFAULT '',
            tipo_pagamento TEXT NOT NULL DEFAULT '',
            competencia TEXT NOT NULL DEFAULT '',
            parcela TEXT NOT NULL DEFAULT '',
            situacao TEXT NOT NULL DEFAULT '',
            vencimento TEXT NOT NULL DEFAULT '',
            valor REAL NOT NULL DEFAULT 0,
            emails TEXT NOT NULL DEFAULT '[]',
            phones TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'aberto',
            origem TEXT NOT NULL DEFAULT 's4e',
            import_id TEXT NOT NULL DEFAULT '',
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            last_contact_at TEXT,
            next_contact TEXT,
            contact_count INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            closed_at TEXT
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS cobranca_cases_status ON cobranca_cases(status, vencimento)")
    db.execute("CREATE INDEX IF NOT EXISTS cobranca_cases_doc ON cobranca_cases(documento)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS cobranca_history (
            id TEXT PRIMARY KEY,
            case_id TEXT NOT NULL,
            at TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT '',
            template_name TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            user_name TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            next_contact TEXT
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS cobranca_history_case ON cobranca_history(case_id, at)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS cobranca_sends (
            id TEXT PRIMARY KEY,
            at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'empresa',
            company_key TEXT NOT NULL DEFAULT '',
            company_name TEXT NOT NULL DEFAULT '',
            documento TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            cc TEXT NOT NULL DEFAULT '[]',
            cases INTEGER NOT NULL DEFAULT 0,
            value REAL NOT NULL DEFAULT 0,
            channel TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            provider_ref TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            user_name TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS cobranca_sends_at ON cobranca_sends(at)")
    db.execute("CREATE INDEX IF NOT EXISTS cobranca_sends_company ON cobranca_sends(company_key, at)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS cobranca_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
            tipo TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS cobranca_imports (
            id TEXT PRIMARY KEY,
            at TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT '',
            user_name TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'extensao',
            total INTEGER NOT NULL DEFAULT 0,
            criados INTEGER NOT NULL DEFAULT 0,
            atualizados INTEGER NOT NULL DEFAULT 0,
            baixados INTEGER NOT NULL DEFAULT 0,
            ignorados INTEGER NOT NULL DEFAULT 0,
            sem_email INTEGER NOT NULL DEFAULT 0,
            sem_whatsapp INTEGER NOT NULL DEFAULT 0,
            period_start TEXT NOT NULL DEFAULT '',
            period_end TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS apuracao_runs (
            id TEXT PRIMARY KEY,
            competencia TEXT NOT NULL,
            competencia_label TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT 'manual',
            status TEXT NOT NULL DEFAULT 'running',
            started_at TEXT NOT NULL,
            finished_at TEXT,
            error TEXT,
            total_rows INTEGER NOT NULL DEFAULT 0,
            total_empresas INTEGER NOT NULL DEFAULT 0,
            pagas INTEGER NOT NULL DEFAULT 0,
            file_path TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS apuracao_rows (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            grupo_mae TEXT NOT NULL DEFAULT '',
            grupo_empresa TEXT NOT NULL DEFAULT '',
            empresa TEXT NOT NULL DEFAULT '',
            documento TEXT NOT NULL DEFAULT '',
            vidas TEXT NOT NULL DEFAULT '',
            vencimento TEXT NOT NULL DEFAULT '',
            valor REAL NOT NULL DEFAULT 0,
            data_pagamento TEXT NOT NULL DEFAULT '',
            valor_recebido REAL NOT NULL DEFAULT 0,
            pago INTEGER NOT NULL DEFAULT 0,
            tipo_pagamento TEXT NOT NULL DEFAULT '',
            competencia TEXT NOT NULL DEFAULT '',
            nf TEXT NOT NULL DEFAULT ''
        )"""
    )
    apuracao_columns = {row[1] for row in db.execute("PRAGMA table_info(apuracao_rows)")}
    if "nf_url" not in apuracao_columns:
        db.execute("ALTER TABLE apuracao_rows ADD COLUMN nf_url TEXT NOT NULL DEFAULT ''")
    for column in ("imposto", "multa", "acrescimo", "desconto", "tarifa", "titulo"):
        if column not in apuracao_columns:
            db.execute(f"ALTER TABLE apuracao_rows ADD COLUMN {column} REAL NOT NULL DEFAULT 0")
    for column in ("taxa", "acrescimo_avulso", "desconto_pagamento", "vl_plano", "vl_orto", "vl_prorata"):
        if column not in apuracao_columns:
            db.execute(f"ALTER TABLE apuracao_rows ADD COLUMN {column} REAL NOT NULL DEFAULT 0")
    for column in ("empresa_s4e", "departamento", "situacao", "gerado", "data_credito", "tipo_parcela", "tipo_recebimento", "parcela", "nf_lote", "emissao", "vendedor"):
        if column not in apuracao_columns:
            db.execute(f"ALTER TABLE apuracao_rows ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    db.execute("CREATE INDEX IF NOT EXISTS apuracao_rows_run ON apuracao_rows(run_id)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS rateio_rules (
            id TEXT PRIMARY KEY,
            grupo TEXT NOT NULL DEFAULT '',
            empresa TEXT NOT NULL DEFAULT '',
            recebedor TEXT NOT NULL DEFAULT '',
            metodo TEXT NOT NULL DEFAULT 'por_vida',
            valor REAL NOT NULL DEFAULT 0,
            ativo INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(grupo, empresa, recebedor)
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS rateio_rules_group ON rateio_rules(grupo)")
    rateio_columns = {row[1] for row in db.execute("PRAGMA table_info(rateio_rules)")}
    if "grupo_empresa" not in rateio_columns:
        db.execute("ALTER TABLE rateio_rules ADD COLUMN grupo_empresa TEXT NOT NULL DEFAULT ''")
    if "vigencia_inicio" not in rateio_columns:
        db.execute("ALTER TABLE rateio_rules ADD COLUMN vigencia_inicio TEXT NOT NULL DEFAULT ''")
    if "vigencia_fim" not in rateio_columns:
        db.execute("ALTER TABLE rateio_rules ADD COLUMN vigencia_fim TEXT NOT NULL DEFAULT ''")
    run_columns = {row[1] for row in db.execute("PRAGMA table_info(apuracao_runs)")}
    if "timings" not in run_columns:
        db.execute("ALTER TABLE apuracao_runs ADD COLUMN timings TEXT NOT NULL DEFAULT ''")
    # O conteúdo de um lote de NFS-e não muda: guardar evita reconsultar o S4E a cada apuração.
    db.execute(
        """CREATE TABLE IF NOT EXISTS apuracao_nf_lots (
            lot TEXT PRIMARY KEY,
            links TEXT NOT NULL DEFAULT '[]',
            fetched_at TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS apuracao_map (
            id TEXT PRIMARY KEY,
            grupo TEXT NOT NULL DEFAULT '',
            tipo_pagamento TEXT NOT NULL DEFAULT '',
            grupo_mae TEXT NOT NULL DEFAULT '',
            UNIQUE(grupo, tipo_pagamento)
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS recibo_runs (
            id TEXT PRIMARY KEY,
            period_start TEXT NOT NULL DEFAULT '',
            period_end TEXT NOT NULL DEFAULT '',
            centro_custo TEXT NOT NULL DEFAULT '',
            grupo TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            phase TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            total INTEGER NOT NULL DEFAULT 0,
            gerados INTEGER NOT NULL DEFAULT 0,
            ignorados INTEGER NOT NULL DEFAULT 0,
            erros INTEGER NOT NULL DEFAULT 0,
            empresas INTEGER NOT NULL DEFAULT 0,
            folder TEXT NOT NULL DEFAULT '',
            zip_path TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            started_at TEXT NOT NULL,
            finished_at TEXT,
            error TEXT
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS recibo_items (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            parcela TEXT NOT NULL DEFAULT '',
            empresa TEXT NOT NULL DEFAULT '',
            documento TEXT NOT NULL DEFAULT '',
            grupo_mae TEXT NOT NULL DEFAULT '',
            grupo_empresa TEXT NOT NULL DEFAULT '',
            vencimento TEXT NOT NULL DEFAULT '',
            valor REAL NOT NULL DEFAULT 0,
            data_credito TEXT NOT NULL DEFAULT '',
            competencia TEXT NOT NULL DEFAULT '',
            tipo_parcela TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS recibo_items_run ON recibo_items(run_id)")
    recibo_cols = {row[1] for row in db.execute("PRAGMA table_info(recibo_runs)")}
    if "sindicato" in recibo_cols:
        db.execute("ALTER TABLE recibo_runs RENAME COLUMN grupo TO centro_custo")
        db.execute("ALTER TABLE recibo_runs RENAME COLUMN sindicato TO grupo")
    retornos.ensure_schema(db)
    vendas.ensure_schema(db)
    vidas.ensure_schema(db)
    s4e_notas.ensure_schema(db)
    task_sync.ensure_schema(db)
    relatorio_semanal.ensure_schema(db)
    cobranca_cols = {row[1] for row in db.execute("PRAGMA table_info(cobranca_cases)")}
    if "nao_cobrar" not in cobranca_cols:
        db.execute("ALTER TABLE cobranca_cases ADD COLUMN nao_cobrar INTEGER NOT NULL DEFAULT 0")
    if "cancelada" not in cobranca_cols:
        db.execute("ALTER TABLE cobranca_cases ADD COLUMN cancelada INTEGER NOT NULL DEFAULT 0")
    # Depósito bancário não entra em cobrança, mas continua na fila e no histórico.
    if db.execute(
        "SELECT 1 FROM cobranca_cases WHERE nao_cobrar = 0 AND upper(tipo_pagamento) LIKE '%DEP%SITO%' LIMIT 1"
    ).fetchone():
        db.execute(
            "UPDATE cobranca_cases SET nao_cobrar = 1 WHERE upper(tipo_pagamento) LIKE '%DEP%SITO%'"
        )
    # Empresa cancelada também fica na fila para consulta, mas não é cobrada.
    if db.execute(
        "SELECT 1 FROM cobranca_cases WHERE cancelada = 0 AND (upper(situacao) LIKE '%CANCELAD%' "
        "OR upper(situacao) LIKE '%SUSPENSO PARA CANCELAMENTO%') LIMIT 1"
    ).fetchone():
        db.execute(
            "UPDATE cobranca_cases SET cancelada = 1 WHERE upper(situacao) LIKE '%CANCELAD%' "
            "OR upper(situacao) LIKE '%SUSPENSO PARA CANCELAMENTO%'"
        )
    if db.execute(
        "SELECT 1 FROM users WHERE sector_id IS NOT NULL AND NOT EXISTS ("
        "SELECT 1 FROM user_sectors WHERE user_sectors.user_id = users.id "
        "AND user_sectors.sector_id = users.sector_id) LIMIT 1"
    ).fetchone():
        db.execute("INSERT OR IGNORE INTO user_sectors(user_id, sector_id) SELECT id, sector_id FROM users WHERE sector_id IS NOT NULL")
    db.commit()
    seed_cobranca_templates(db)
    seed(db)
    seed_birthdays(db)
    unify_cadastro_faturamento(db)
    seed_system_updates(db)
    seed_system_updates_v2(db)
    seed_system_updates_v3(db)
    ensure_weekly_digest(db)
    # Nenhuma rotina de preparação pode devolver a conexão com transação aberta:
    # os endpoints que abrem "BEGIN IMMEDIATE" falhariam com "transaction within a transaction".
    db.commit()
    return db


def seed_birthdays(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'birthdays_seed_v1'").fetchone():
        return
    for bd_id, month, day, year, kind, note, link, name in BIRTHDAY_SEED:
        user_id = None
        if link:
            row = db.execute("SELECT id FROM users WHERE lower(display_name) = ?", (link.lower(),)).fetchone()
            user_id = row["id"] if row else None
        db.execute(
            "INSERT OR IGNORE INTO birthdays(id, user_id, name, day, month, year, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (bd_id, user_id, name, day, month, year, kind, note, now_iso()),
        )
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('birthdays_seed_v1', ?)", (now_iso(),))
    db.commit()


def sync_user_birthday(db, user_id, display_name, birthdate):
    row = db.execute("SELECT id FROM birthdays WHERE user_id = ?", (user_id,)).fetchone()
    parsed = None
    if birthdate:
        try:
            parsed = datetime.strptime(birthdate, "%Y-%m-%d").date()
        except ValueError:
            parsed = None
    if row:
        if parsed:
            db.execute(
                "UPDATE birthdays SET name = ?, day = ?, month = ?, year = ? WHERE id = ?",
                (display_name, parsed.day, parsed.month, parsed.year, row["id"]),
            )
        else:
            db.execute("UPDATE birthdays SET name = ? WHERE id = ?", (display_name, row["id"]))
        return
    if parsed:
        db.execute(
            "INSERT INTO birthdays(id, user_id, name, day, month, year, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, 'team', '', ?)",
            (str(uuid.uuid4()), user_id, display_name, parsed.day, parsed.month, parsed.year, now_iso()),
        )


def seed(db):
    changed = False
    if not db.execute("SELECT 1 FROM sectors WHERE id = ?", (DEFAULT_SECTOR_ID,)).fetchone():
        db.execute(
            "INSERT OR IGNORE INTO sectors(id, name, description, created_at) VALUES (?, ?, ?, ?)",
            (DEFAULT_SECTOR_ID, DEFAULT_SECTOR_NAME, "Cadastro e faturamento trabalham juntos no mesmo plantão.", now_iso()),
        )
        changed = True
    if db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0:
        admin_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (admin_id, "admin", "Administrador", hash_password("admin123"), "admin", None, now_iso()),
        )
        changed = True
    if not db.execute("SELECT 1 FROM users WHERE lower(username) = 'kaynan'").fetchone():
        db.execute(
            "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), "KAYNAN", "KAYNAN", hash_password("883816"), "admin", None, now_iso()),
        )
        changed = True
    existing_screens = {row["id"] for row in db.execute("SELECT id FROM screens").fetchall()}
    for screen_id, name, sector, description in BUILTIN_SCREENS:
        if screen_id in existing_screens:
            continue
        db.execute(
            "INSERT OR IGNORE INTO screens(id, name, kind, sector, description, content, created_at) VALUES (?, ?, 'builtin', ?, ?, '{}', ?)",
            (screen_id, name, sector, description, now_iso()),
        )
        changed = True
    # Keep the demands screen label synchronized for existing installations.
    renamed = db.execute(
        "UPDATE screens SET name = ? WHERE id = 'tasksScreen' AND name IN ('Plantão de Demandas', 'Intranet Rede Saúde')",
        ("Demandas",),
    ).rowcount
    changed = changed or bool(renamed)
    if changed:
        db.commit()


def unify_cadastro_faturamento(db):
    created = False
    if not db.execute("SELECT 1 FROM sectors WHERE id = ?", (DEFAULT_SECTOR_ID,)).fetchone():
        db.execute(
            "INSERT OR IGNORE INTO sectors(id, name, description, created_at) VALUES (?, ?, ?, ?)",
            (DEFAULT_SECTOR_ID, DEFAULT_SECTOR_NAME, "Cadastro e faturamento trabalham juntos no mesmo plantão.", now_iso()),
        )
        created = True
    extras = db.execute(
        "SELECT * FROM sectors WHERE id != ? AND lower(name) IN ('cadastro', 'faturamento')",
        (DEFAULT_SECTOR_ID,),
    ).fetchall()
    extra_ids = [row["id"] for row in extras]
    if extra_ids:
        for extra_id in extra_ids:
            db.execute(
                "INSERT OR IGNORE INTO user_sectors(user_id, sector_id) SELECT user_id, ? FROM user_sectors WHERE sector_id = ?",
                (DEFAULT_SECTOR_ID, extra_id),
            )
            db.execute("UPDATE users SET sector_id = ? WHERE sector_id = ?", (DEFAULT_SECTOR_ID, extra_id))
            db.execute("DELETE FROM user_sectors WHERE sector_id = ?", (extra_id,))
            db.execute("DELETE FROM sectors WHERE id = ?", (extra_id,))
        row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
        if row:
            state = json.loads(row["data"])
            changed = False
            for task in state.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                if task.get("sectorId") in extra_ids:
                    task["sectorId"] = DEFAULT_SECTOR_ID
                    changed = True
                if str(task.get("category") or "").strip().lower() in ("cadastro", "faturamento"):
                    task["category"] = DEFAULT_SECTOR_NAME
                    changed = True
            if changed:
                db.execute(
                    "UPDATE portal_state SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                    (json.dumps(state, ensure_ascii=False),),
                )
        db.commit()
    elif created:
        db.commit()


def sector_name(db, sector_id):
    if not sector_id:
        return ""
    row = db.execute("SELECT name FROM sectors WHERE id = ?", (sector_id,)).fetchone()
    return row["name"] if row else ""


def row_sector(row):
    return {"id": row["id"], "name": row["name"], "description": row["description"], "createdAt": row["created_at"]}


DAILY_SERIES_ACTIVE_DAYS = 10


def seed_weekend_schedule(db):
    """Primeira migração: deduz do histórico quem já trabalhou em sábado e domingo."""
    try:
        row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    except sqlite3.Error:
        return
    if not row:
        return
    try:
        tasks = json.loads(row["data"]).get("tasks") or []
    except (ValueError, AttributeError):
        return
    evidence = {}
    sunday_off = set()
    for task in tasks:
        if not isinstance(task, dict) or task.get("recurrence") != "daily":
            continue
        try:
            due = date.fromisoformat(str(task.get("due") or "")[:10])
        except ValueError:
            continue
        owner = normalize_name(task.get("owner"))
        if not owner:
            continue
        sat, sun = evidence.get(owner, (0, 0))
        sat = sat or int(due.weekday() == 5)
        sun = sun or int(due.weekday() == 6)
        evidence[owner] = (sat, sun)
        note = normalize_name(task.get("notes"))
        if "domingo" in note and "realiz" in note:
            sunday_off.add(owner)
    for user in db.execute("SELECT id, display_name FROM users").fetchall():
        key = normalize_name(user["display_name"])
        sat, sun = evidence.get(key, (0, 0))
        if key in sunday_off:
            sun = 0
        db.execute(
            "UPDATE users SET works_saturday = ?, works_sunday = ? WHERE id = ?",
            (sat, sun, user["id"]),
        )
    db.commit()


def weekend_calendar(db):
    users = {}
    sectors = {}
    rows = db.execute(
        """SELECT u.display_name, u.sector_id, u.works_saturday, u.works_sunday, us.sector_id AS linked_sector
           FROM users u LEFT JOIN user_sectors us ON us.user_id = u.id"""
    ).fetchall()
    for row in rows:
        flags = (bool(row["works_saturday"]), bool(row["works_sunday"]))
        users[normalize_name(row["display_name"])] = flags
        for sector_id in {row["sector_id"], row["linked_sector"]}:
            if sector_id:
                sectors.setdefault(sector_id, []).append(flags)
    return users, sectors


def works_on_day(owner, sector_id, when, users, sectors):
    if when.weekday() < 5:
        return True
    index = 0 if when.weekday() == 5 else 1
    key = normalize_name(owner)
    if key in ("ambos", "dupla"):
        members = sectors.get(sector_id or "", [])
        return any(flags[index] for flags in members)
    flags = users.get(key)
    return bool(flags[index]) if flags else False


def next_working_day(start, owner, sector_id, users, sectors):
    when = start
    for _ in range(14):
        if works_on_day(owner, sector_id, when, users, sectors):
            return when
        when += timedelta(days=1)
    return when


def task_series_key(task):
    return (
        str(task.get("recurrence") or ""),
        normalize_name(task.get("owner")),
        normalize_name(task.get("title")),
    )


def build_recurring_task(template, when):
    timestamp = now_iso()
    checklist = [
        {"id": str(uuid.uuid4()), "text": item.get("text") or "", "done": False}
        for item in template.get("checklist") or []
        if isinstance(item, dict)
    ]
    return {
        "id": str(uuid.uuid4()),
        "title": template.get("title") or "",
        "due": when.isoformat(),
        "periodStart": when.isoformat(),
        "periodEnd": when.isoformat(),
        "sectorId": template.get("sectorId"),
        "owner": template.get("owner"),
        "category": template.get("category"),
        "priority": template.get("priority") or "medium",
        "recurrence": "daily",
        "status": "todo",
        "notes": template.get("notes") or "",
        "checklist": checklist,
        "attachments": [],
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": None,
    }


def ensure_recurring_occurrences(state, db, reference=None):
    """Garante uma ocorrência diária em aberto para hoje (ou para o próximo dia útil)."""
    tasks = state.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return False
    current = reference or date.today()
    users, sectors = weekend_calendar(db)
    groups = {}
    for task in tasks:
        if not isinstance(task, dict) or task.get("recurrence") != "daily":
            continue
        try:
            due = date.fromisoformat(str(task.get("due") or task.get("periodEnd") or "")[:10])
        except ValueError:
            continue
        groups.setdefault(task_series_key(task), []).append((due, task))
    changed = False
    for entries in groups.values():
        entries.sort(key=lambda item: item[0])
        latest_date, template = entries[-1]
        if (current - latest_date).days > DAILY_SERIES_ACTIVE_DAYS:
            continue
        skips = {str(item) for _, task in entries for item in (task.get("recurrenceSkips") or [])}
        if current.isoformat() in skips or any(due == current for due, _ in entries):
            continue
        owner = template.get("owner")
        sector_id = template.get("sectorId")
        working_today = works_on_day(owner, sector_id, current, users, sectors)
        target = next_working_day(current, owner, sector_id, users, sectors)
        if target.isoformat() in skips or any(due == target for due, _ in entries):
            continue
        future_open = [
            (due, item) for due, item in entries
            if due > current and str(item.get("status")) != "done"
        ]
        if future_open and (working_today or future_open[0][0] < target):
            _, item = future_open[0]
            item["due"] = target.isoformat()
            item["periodStart"] = target.isoformat()
            item["periodEnd"] = target.isoformat()
            item["updatedAt"] = now_iso()
            changed = True
            continue
        created = build_recurring_task(template, target)
        tasks.append(created)
        entries.append((target, created))
        changed = True
    return changed


def row_user(db, user, include_screens=True):
    sector_id = user["sector_id"] if "sector_id" in user.keys() else None
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ? ORDER BY sector_id", (user["id"],))]
    if sector_id and sector_id not in sector_ids:
        sector_ids.insert(0, sector_id)
    sectors = [row_sector(row) for row in db.execute(f"SELECT * FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name", sector_ids)] if sector_ids else []
    photo = (user["photo"] if "photo" in user.keys() else None) or ""
    if not photo and user["display_name"]:
        match = db.execute(
            "SELECT photo FROM users WHERE id != ? AND photo IS NOT NULL AND trim(photo) != '' AND lower(trim(display_name)) = lower(trim(?)) LIMIT 1",
            (user["id"], user["display_name"]),
        ).fetchone()
        if match:
            photo = match["photo"] or ""
    payload = {
        "id": user["id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": user["role"],
        "management": bool(user["management"]) if "management" in user.keys() else False,
        "sectorId": sector_id,
        "sectorName": sector_name(db, sector_id),
        "sectorIds": sector_ids,
        "sectors": sectors,
        "birthday": user["birthday"] if "birthday" in user.keys() else None,
        "photo": photo,
        "status": user_status(user),
        "sellerName": user["seller_name"] if "seller_name" in user.keys() else "",
        "active": bool(user["active"]) if "active" in user.keys() else True,
        "worksSaturday": bool(user["works_saturday"]) if "works_saturday" in user.keys() else False,
        "worksSunday": bool(user["works_sunday"]) if "works_sunday" in user.keys() else False,
        "createdAt": user["created_at"],
    }
    if include_screens:
        screens = [row["screen_id"] for row in db.execute("SELECT screen_id FROM user_screens WHERE user_id = ?", (user["id"],))]
        payload["screens"] = sorted(set(screens) - DISABLED_SCREENS)
        is_manager = user["role"] == "admin" or ("management" in user.keys() and user["management"])
        payload["allowedScreens"] = allowed_screens(user["role"], screens, is_manager)
        teammate_columns = "u.id, u.display_name, u.sector_id, u.works_saturday, u.works_sunday"
        if not is_manager and sector_ids:
            teammate_rows = db.execute(
                f"SELECT DISTINCT {teammate_columns} FROM users u JOIN user_sectors us ON us.user_id = u.id WHERE us.sector_id IN ({','.join('?' for _ in sector_ids)}) AND u.id != ? ORDER BY u.display_name",
                (*sector_ids, user["id"]),
            ).fetchall()
        else:
            teammate_rows = db.execute(
                f"SELECT {teammate_columns} FROM users u WHERE u.id != ? ORDER BY u.display_name",
                (user["id"],),
            ).fetchall()
        payload["teammates"] = []
        for row in teammate_rows:
            mate_ids = [item["sector_id"] for item in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (row["id"],))]
            if row["sector_id"] and row["sector_id"] not in mate_ids:
                mate_ids.insert(0, row["sector_id"])
            payload["teammates"].append({
                "id": row["id"],
                "displayName": row["display_name"],
                "sectorId": row["sector_id"],
                "sectorIds": mate_ids,
                "worksSaturday": bool(row["works_saturday"]),
                "worksSunday": bool(row["works_sunday"]),
            })
    return payload


def user_sector_ids(db, user):
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
    if user["sector_id"] and user["sector_id"] not in sector_ids:
        sector_ids.insert(0, user["sector_id"])
    return sector_ids


def is_manager(user):
    return user["role"] == "admin" or ("management" in user.keys() and bool(user["management"]))


FEED_KINDS = {"post", "notice", "event", "digest"}


def feed_author_payload(row):
    if not row:
        return {"id": None, "name": "Portal", "photo": ""}
    return {
        "id": row["id"],
        "name": row["display_name"] or row["username"] or "Pessoa",
        "photo": row["photo"] or "",
        "sector": (row["sector_name"] if "sector_name" in row.keys() else "") or "",
    }


def feed_likers(db, post_id):
    rows = db.execute(
        """SELECT u.id, u.display_name, u.username, u.photo
           FROM feed_likes l LEFT JOIN users u ON u.id = l.user_id
           WHERE l.post_id = ? ORDER BY l.created_at""",
        (post_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["display_name"] or row["username"] or "Pessoa",
            "photo": row["photo"] or "",
        }
        for row in rows
    ]


def feed_post_view(db, row, user):
    try:
        meta = json.loads(row["meta"] or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}
    author = None
    if row["author_id"]:
        author = db.execute(
            """SELECT u.id, u.display_name, u.username, u.photo, s.name AS sector_name
               FROM users u LEFT JOIN sectors s ON s.id = u.sector_id WHERE u.id = ?""",
            (row["author_id"],),
        ).fetchone()
    media_rows = db.execute(
        "SELECT * FROM feed_media WHERE post_id = ? ORDER BY rowid",
        (row["id"],),
    ).fetchall()
    like_count = db.execute(
        "SELECT COUNT(*) AS n FROM feed_likes WHERE post_id = ?",
        (row["id"],),
    ).fetchone()["n"]
    liked = bool(db.execute(
        "SELECT 1 FROM feed_likes WHERE post_id = ? AND user_id = ?",
        (row["id"], user["id"]),
    ).fetchone())
    comment_rows = db.execute(
        """SELECT c.*, u.display_name, u.username, u.photo
           FROM feed_comments c LEFT JOIN users u ON u.id = c.author_id
           WHERE c.post_id = ? ORDER BY c.created_at""",
        (row["id"],),
    ).fetchall()
    comments = [
        {
            "id": comment["id"],
            "parentId": comment["parent_id"] or "",
            "body": comment["body"],
            "createdAt": comment["created_at"],
            "author": {
                "id": comment["author_id"],
                "name": comment["display_name"] or comment["username"] or "Pessoa",
                "photo": comment["photo"] or "",
            },
            "canDelete": is_manager(user) or comment["author_id"] == user["id"],
        }
        for comment in comment_rows
    ]
    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "body": row["body"],
        "meta": meta,
        "createdAt": row["created_at"],
        "author": feed_author_payload(author),
        "media": [
            {"media": item["media"], "mime": item["mime"], "name": item["name"], "size": item["size"]}
            for item in media_rows
        ],
        "likes": like_count,
        "liked": liked,
        "likers": feed_likers(db, row["id"]),
        "comments": comments,
        "canDelete": is_manager(user) or (row["author_id"] or "") == user["id"],
    }


def feed_unread_count(db, user_id):
    return db.execute(
        """SELECT COUNT(*) AS n FROM feed_posts p
           WHERE NOT EXISTS (SELECT 1 FROM feed_reads r WHERE r.post_id = p.id AND r.user_id = ?)""",
        (user_id,),
    ).fetchone()["n"]


def delete_feed_media_files(rows):
    for row in rows:
        name = str(row["media"] or "").rpartition("/")[2]
        if not name:
            continue
        try:
            (MEDIA_DIR / name).unlink(missing_ok=True)
        except OSError:
            continue


def feed_notice_view(row):
    return {
        "id": row["id"],
        "postId": row["post_id"] or "",
        "postTitle": row["post_title"] or "",
        "reason": row["reason"] or "",
        "createdAt": row["created_at"],
        "seen": bool(row["seen_at"]),
    }


def system_update_view(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"] or "",
        "createdAt": row["created_at"],
    }


PORTAL_START_DATE = date(2026, 8, 17)
PORTAL_START_LABEL = "17 de agosto de 2026"


def portal_summary(db):
    today = date.today()
    days = max((today - PORTAL_START_DATE).days, 1)
    months = (today.year - PORTAL_START_DATE.year) * 12 + today.month - PORTAL_START_DATE.month
    if today.day < PORTAL_START_DATE.day:
        months -= 1
    demands_total = demands_done = 0
    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    if row and row["data"]:
        try:
            tasks = json.loads(row["data"]).get("tasks") or []
        except (TypeError, ValueError):
            tasks = []
        demands_total = len(tasks)
        demands_done = sum(1 for task in tasks if task.get("status") == "done")
    return {
        "since": PORTAL_START_DATE.isoformat(),
        "sinceLabel": PORTAL_START_LABEL,
        "days": days,
        "months": max(months, 0),
        "anniversary": today.day == PORTAL_START_DATE.day,
        "people": db.execute("SELECT COUNT(*) FROM users").fetchone()[0],
        "companies": db.execute("SELECT COUNT(*) FROM contract_companies").fetchone()[0],
        "posts": db.execute("SELECT COUNT(*) FROM feed_posts").fetchone()[0],
        "updates": db.execute("SELECT COUNT(*) FROM system_updates").fetchone()[0],
        "demandsTotal": demands_total,
        "demandsDone": demands_done,
    }


SYSTEM_UPDATE_SEED = (
    ("Mural da Equipe", "Novo módulo com fotos de eventos, avisos, curtidas, comentários e respostas."),
    ("Arrastar demandas no quadro", "No modo Quadro, basta arrastar o cartão para mudar o status da demanda."),
    ("Resumo semanal automático", "Toda semana o portal publica o que foi feito e o que mudou no sistema."),
    ("Verificação de demandas", "Nova checagem aponta inconsistências nos dados e corrige o que for seguro."),
    ("Criação de demandas renovada", "A tela de nova demanda ficou mais clara, bonita e rápida de preencher."),
    ("Remoção com motivo", "A administração pode retirar publicações indevidas e avisar o autor do motivo."),
)


def seed_system_updates(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'system_updates_seed_v1'").fetchone():
        return
    stamp = now_iso()
    for index, (title, body) in enumerate(SYSTEM_UPDATE_SEED):
        db.execute(
            "INSERT OR IGNORE INTO system_updates(id, title, body, created_at) VALUES (?, ?, ?, ?)",
            (f"update-{index + 1}", title, body, stamp),
        )
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('system_updates_seed_v1', ?)", (stamp,))
    db.commit()


SYSTEM_UPDATE_SEED_V2 = (
    ("update-v2-01", "Cobrança automática", "A fila de empresas em atraso é atualizada sozinha pelo S4E, e a cobrança em lote monta um e-mail por empresa já com o que ela deve.", "2026-11-10"),
    ("update-v2-02", "Apuração automática", "A apuração do mês se atualiza sozinha nos dias úteis, e cada nota abre o link oficial no S4E para conferência.", "2026-11-11"),
    ("update-v2-03", "Retorno Instituição", "Nova tela mostra o que deu erro e o que já foi corrigido em cada instituição, com conferência automática a cada 5 minutos.", "2026-11-11"),
    ("update-v2-04", "Acompanhamento de Vendas", "Vendas e cancelamentos oficiais por equipe, com vínculo a Contratos e Comissões. Consulta externa somente de leitura.", "2026-11-11"),
    ("update-v2-05", "Avisos de contratos e cadastros", "Receba avisos no computador de novos contratos, retornos das instituições e mudanças no cadastro de empresas.", "2026-11-12"),
    ("update-v2-06", "Demandas sem internet", "O portal continua funcionando quando a conexão cai: as alterações ficam guardadas e sincronizam sozinhas quando ela volta.", "2026-11-12"),
    ("update-v2-07", "Movimentação de Vidas", "Quem entrou, quem saiu e quem trouxe cada vida no período, com gráficos, comparação da carteira e exportação da planilha.", "2026-11-13"),
    ("update-v2-08", "Inclusão e Exclusão de vidas", "Prepare a lista de inclusão ou exclusão, confira os dados na prévia e baixe o arquivo para conferência.", "2026-11-13"),
    ("update-v2-09", "Conferência de Notas", "Compara títulos, parcelas e notas fiscais do S4E e aponta duplicidades confirmadas, prováveis e suspeitas antes do fechamento.", "2026-11-13"),
    ("update-v2-10", "Recibos em PDF", "Baixe os recibos oficiais das empresas que pagaram, em uma pasta de PDFs separada por centro de custo, grupo e empresa.", "2026-11-13"),
    ("update-v2-11", "Empresa cadastrada nas Comissões", "Marque a empresa como cadastrada e o vendedor recebe o aviso assim que esse status mudar.", "2026-11-13"),
    ("update-v2-12", "Status do time", "Escolha um emoji e uma frase curta para mostrar como você está hoje; o status aparece para o time e pode durar o dia, a semana ou ficar fixo.", "2026-11-13"),
)


def seed_system_updates_v2(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'system_updates_seed_v2'").fetchone():
        return
    stamp = now_iso()
    for index, (update_id, title, body, day) in enumerate(SYSTEM_UPDATE_SEED_V2):
        db.execute(
            "INSERT OR IGNORE INTO system_updates(id, title, body, created_at) VALUES (?, ?, ?, ?)",
            (update_id, title, body, f"{day}T12:{index:02d}:00+00:00"),
        )
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('system_updates_seed_v2', ?)", (stamp,))
    db.commit()


SYSTEM_UPDATE_SEED_V3 = (
    ("update-v3-01", "Conciliação bancária no Rateio", "O recebido no Rateio de Faturamento agora vem do retorno do banco e é conferido com o relatório analítico. Quando não bate, o portal explica por empresa: fora da apuração, título em aberto no S4E, pagamento de outro mês ou valor divergente.", "2026-11-17"),
    ("update-v3-02", "Diferença recebida explicada", "Cada diferença entre o faturado e o recebido aparece separada por imposto, juros e multa ou desconto — na tabela, no detalhe do lançamento e na planilha exportada.", "2026-11-17"),
    ("update-v3-03", "3 meses do Portal do Setor", "O Portal do Setor completa 3 meses no ar, reunindo demandas, mural, contratos, retornos e rateios no mesmo lugar. Até aqui foram 728 demandas concluídas pelo time.", "2026-11-17"),
)


def seed_system_updates_v3(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'system_updates_seed_v3'").fetchone():
        return
    stamp = now_iso()
    for index, (update_id, title, body, day) in enumerate(SYSTEM_UPDATE_SEED_V3):
        db.execute(
            "INSERT OR IGNORE INTO system_updates(id, title, body, created_at) VALUES (?, ?, ?, ?)",
            (update_id, title, body, f"{day}T12:{index:02d}:00+00:00"),
        )
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('system_updates_seed_v3', ?)", (stamp,))
    db.commit()


def ensure_weekly_digest(db):
    iso = date.today().isocalendar()
    week_key = f"{iso[0]}-W{iso[1]:02d}"
    current = db.execute("SELECT value FROM meta WHERE key = 'feed_digest_week'").fetchone()
    same_week = bool(current and current["value"] == week_key)
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=7)).isoformat()
    state_row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    state = json.loads(state_row["data"]) if state_row else {}
    tasks = [task for task in (state.get("tasks") or []) if isinstance(task, dict)]
    completed = [task for task in tasks if task.get("status") == "done" and str(task.get("completedAt") or "") >= since]
    created = [task for task in tasks if str(task.get("createdAt") or "") >= since]
    companies = db.execute(
        "SELECT COUNT(*) AS n FROM contract_companies WHERE created_at >= ?",
        (since,),
    ).fetchone()["n"]
    posts = db.execute(
        "SELECT COUNT(*) AS n FROM feed_posts WHERE created_at >= ? AND kind != 'digest'",
        (since,),
    ).fetchone()["n"]
    updates = [
        {"id": row["id"], "title": row["title"], "body": row["body"], "createdAt": row["created_at"]}
        for row in db.execute(
            "SELECT * FROM system_updates WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5",
            (since,),
        ).fetchall()
    ]
    stats = [
        {"label": "Demandas concluídas", "value": len(completed)},
        {"label": "Novas demandas", "value": len(created)},
        {"label": "Novos contratos", "value": companies},
        {"label": "Publicações no mural", "value": posts},
    ]
    body = (
        "Nesta semana o portal registrou:\n"
        f"• {len(completed)} demandas concluídas\n"
        f"• {len(created)} novas demandas\n"
        f"• {companies} novos contratos\n"
        f"• {posts} publicações no mural"
    )
    if updates:
        body += "\n\nO que mudou no sistema:\n" + "\n".join(f"• {item['title']}: {item['body']}" for item in updates)
    today = date.today()
    title = f"Resumo da semana · {today.strftime('%d/%m')}"
    post_id = f"weekly-digest-{week_key}"
    meta_json = json.dumps({"stats": stats, "week": week_key, "updates": updates}, ensure_ascii=False)
    existing = db.execute("SELECT * FROM feed_posts WHERE id = ?", (post_id,)).fetchone()
    wrote = False
    if existing is None:
        db.execute(
            "INSERT OR IGNORE INTO feed_posts(id, author_id, kind, title, body, meta, created_at) VALUES (?, NULL, 'digest', ?, ?, ?, ?)",
            (post_id, title, body, meta_json, now.isoformat()),
        )
        wrote = True
    elif existing["title"] != title or existing["body"] != body or existing["meta"] != meta_json:
        db.execute("UPDATE feed_posts SET title = ?, body = ?, meta = ? WHERE id = ?", (title, body, meta_json, post_id))
        wrote = True
    ann_id = f"ann-digest-{week_key}"
    items = state.get("announcements") or []
    state_changed = False
    if not same_week:
        for item in items:
            if isinstance(item, dict) and item.get("weeklyDigest") and item.get("active"):
                item["active"] = False
                state_changed = True
    description = body + "\n\nAbra o Mural da Equipe para acompanhar as novidades."
    announcement = next((item for item in items if isinstance(item, dict) and item.get("id") == ann_id), None)
    if announcement is None:
        if not same_week:
            items.append({
                "id": ann_id,
                "title": title,
                "description": description,
                "date": today.isoformat(),
                "type": "notice",
                "active": True,
                "imageData": None,
                "color": "#0b8f87",
                "weeklyDigest": True,
                "createdAt": now.isoformat(),
                "updatedAt": now.isoformat(),
            })
            state_changed = True
    elif announcement.get("title") != title or announcement.get("description") != description:
        announcement["title"] = title
        announcement["description"] = description
        announcement["updatedAt"] = now.isoformat()
        state_changed = True
    if state_changed:
        state["announcements"] = items
        db.execute(
            "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
            (json.dumps(state, ensure_ascii=False),),
        )
        wrote = True
    if not same_week:
        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('feed_digest_week', ?)", (week_key,))
        wrote = True
    if wrote:
        db.commit()


def viewer_sector_ids(db, user):
    """Setores cujas demandas o usuário pode ver. None = todos (administração/gerência)."""
    return None if is_manager(user) else set(user_sector_ids(db, user))


def user_sector_map(db):
    mapping = {}
    for row in db.execute("SELECT user_id, sector_id FROM user_sectors"):
        mapping.setdefault(row["user_id"], set()).add(row["sector_id"])
    for row in db.execute("SELECT id, sector_id FROM users WHERE sector_id IS NOT NULL AND trim(sector_id) != ''"):
        mapping.setdefault(row["id"], set()).add(row["sector_id"])
    return mapping


def normalize_chat_scope(scope, scope_id):
    scope = str(scope or "").strip()
    scope_id = str(scope_id or "").strip()
    if scope == "team":
        return "team", ""
    if scope == "sector":
        return ("sector", scope_id) if scope_id else None
    if scope == "direct":
        parts = [part for part in scope_id.split("|") if part]
        if len(parts) != 2 or parts[0] == parts[1]:
            return None
        return "direct", "|".join(sorted(parts))
    return None


def chat_access(db, user, scope, scope_id):
    if scope == "team":
        return True
    if scope == "sector":
        if not db.execute("SELECT 1 FROM sectors WHERE id = ?", (scope_id,)).fetchone():
            return False
        return user["role"] == "admin" or scope_id in user_sector_ids(db, user)
    if scope == "direct":
        parts = scope_id.split("|")
        if user["id"] not in parts:
            return False
        other_id = parts[1] if parts[0] == user["id"] else parts[0]
        return bool(db.execute("SELECT 1 FROM users WHERE id = ?", (other_id,)).fetchone())
    return False


def chat_message_payload(row):
    keys = row.keys()
    media_id = (row["media_id"] if "media_id" in keys else "") or ""
    return {
        "id": row["id"],
        "scope": row["scope"],
        "scopeId": row["scope_id"],
        "userId": row["user_id"],
        "userName": row["display_name"] or "Conta removida",
        "photo": row["photo"] or "",
        "body": row["body"],
        "kind": (row["kind"] if "kind" in keys else "text") or "text",
        "media": f"/media/{media_id}" if media_id else "",
        "mediaMime": (row["media_mime"] if "media_mime" in keys else "") or "",
        "mediaName": (row["media_name"] if "media_name" in keys else "") or "",
        "mediaSize": (row["media_size"] if "media_size" in keys else 0) or 0,
        "mediaDuration": (row["media_duration"] if "media_duration" in keys else 0) or 0,
        "createdAt": row["created_at"],
    }


def chat_last_message(db, scope, scope_id):
    row = db.execute(
        """SELECT m.*, u.display_name, u.photo FROM chat_messages m
           LEFT JOIN users u ON u.id = m.user_id
           WHERE m.scope = ? AND m.scope_id = ?
           ORDER BY m.created_at DESC LIMIT 1""",
        (scope, scope_id),
    ).fetchone()
    return chat_message_payload(row) if row else None


def chat_unread(db, user_id, scope, scope_id):
    read = db.execute(
        "SELECT last_read_at FROM chat_reads WHERE user_id = ? AND scope = ? AND scope_id = ?",
        (user_id, scope, scope_id),
    ).fetchone()
    since = read["last_read_at"] if read else ""
    return db.execute(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE scope = ? AND scope_id = ? AND user_id != ? AND created_at > ?",
        (scope, scope_id, user_id, since),
    ).fetchone()["n"]


def chat_mark_read(db, user_id, scope, scope_id, timestamp=None):
    db.execute(
        "INSERT INTO chat_reads(user_id, scope, scope_id, last_read_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, scope, scope_id) DO UPDATE SET last_read_at = excluded.last_read_at",
        (user_id, scope, scope_id, timestamp or now_iso()),
    )


def valid_media_file(name):
    name = str(name or "")
    if not name or "/" in name or "\\" in name or ".." in name:
        return False
    stem, _, ext = name.partition(".")
    return bool(stem) and len(stem) == 36 and ext.isalnum() and 2 <= len(ext) <= 5


def directory_member(row):
    keys = row.keys()
    return {
        "id": row["id"],
        "name": row["display_name"],
        "role": row["role"],
        "photo": (row["photo"] if "photo" in keys else "") or "",
        "status": user_status(row),
    }


STATUS_TEXT_MAX = 80
STATUS_EMOJI_MAX = 8
STATUS_DURATIONS = ("never", "today", "week")


def user_status(row):
    keys = row.keys()
    text = str((row["status_text"] if "status_text" in keys else "") or "").strip()
    if not text:
        return {"emoji": "", "text": "", "until": ""}
    until = str((row["status_until"] if "status_until" in keys else "") or "").strip()
    if until and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", until):
        until = ""
    if until and until < date.today().isoformat():
        return {"emoji": "", "text": "", "until": ""}
    emoji = str((row["status_emoji"] if "status_emoji" in keys else "") or "").strip()
    return {"emoji": emoji, "text": text, "until": until}


def normalize_status(payload, today=None):
    text = " ".join(str(payload.get("text") or "").split())
    if not text:
        return {"emoji": "", "text": "", "until": ""}
    if len(text) > STATUS_TEXT_MAX:
        raise ValueError(f"O status pode ter até {STATUS_TEXT_MAX} caracteres.")
    emoji = re.sub(r"[\x00-\x1f]", "", str(payload.get("emoji") or "")).strip()
    if len(emoji) > STATUS_EMOJI_MAX:
        raise ValueError("Escolha um emoji válido.")
    duration = str(payload.get("duration") or "never").strip().lower()
    if duration not in STATUS_DURATIONS:
        raise ValueError("Duração do status inválida.")
    today = today or date.today()
    until = ""
    if duration == "today":
        until = today.isoformat()
    elif duration == "week":
        until = (today + timedelta(days=6 - today.weekday())).isoformat()
    return {"emoji": emoji, "text": text, "until": until}


def normalize_name(value):
    text = unicodedata.normalize("NFKD", str(value or "").strip().lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(text.split())


# ── Contratos: planilhas, empresas e vidas ──────────────────────────────────
CONTRACT_MAX_UPLOAD = 12_000_000
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
XLSX_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

CONTRACT_COMPANY_LABELS = (
    ("cnpj", ("cnpj",)),
    ("contact_name", ("pessoa de contato", "nome da pessoa de contato", "contato", "responsavel", "responsável")),
    ("accountant_email", ("email do contador", "e-mail do contador", "email contador", "e-mail contabilidade")),
    ("accountant_name", ("contador", "contabilidade", "nome do contador")),
    ("name", ("nome da empresa", "razao social", "razão social", "nome fantasia", "empresa", "cliente")),
    ("phone", ("telefone", "telefone com ddd", "celular com ddd", "telefone celular", "celular", "whatsapp", "fone")),
    ("email", ("e-mail", "email", "correio eletronico")),
    ("plan", ("plano", "produto", "modalidade")),
    ("monthly_value", ("valor por vida", "valor mensal", "mensalidade", "valor", "investimento")),
    ("seller", ("vendedor", "consultor", "responsavel comercial")),
    ("contract_start", ("data de inicio", "data de início", "inicio", "início", "entrada", "assinatura")),
    ("notes", ("observacoes", "observações", "observacao", "obs")),
)
CONTRACT_LIFE_HEADERS = (
    ("name", ("nome", "nome completo", "colaborador", "colaboradora", "beneficiario", "beneficiário", "vida", "nome do colaborador", "nome do beneficiario", "nome titular", "titular", "nome do titular")),
    ("name_alt", ("nome dependente", "nome do dependente", "dependente")),
    ("cpf", ("cpf",)),
    ("birth_date", ("data de nascimento", "data nascimento", "nascimento", "data de nasc", "nasc")),
    ("mother_name", ("nome da mae", "nome da mãe", "mae", "mãe")),
    ("phone", ("celular", "telefone", "whatsapp", "fone", "numero de celular", "número de celular")),
    ("email", ("email", "e-mail")),
    ("role", ("cargo", "funcao", "função")),
)


def digits_only(value):
    return re.sub(r"\D", "", str(value or ""))


def contract_key(value):
    return re.sub(r"[^a-z0-9]+", " ", normalize_name(value)).strip()


def contract_money(value):
    raw = str(value or "").strip()
    if not raw:
        return 0.0
    cleaned = re.sub(r"[^\d,.\-]", "", raw)
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return 0.0


def contract_date(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        serial = float(raw)
    except ValueError:
        serial = None
    if serial is not None and 1 <= serial <= 90000:
        return xlsx_serial_date(raw)
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw[:10], pattern).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw[:40]


def contract_cpf(value):
    raw = str(value or "").strip()
    digits = digits_only(raw)
    if len(digits) == 11:
        return f"{digits[:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:]}"
    return raw[:40]


def contract_cnpj(value):
    raw = str(value or "").strip()
    digits = digits_only(raw)
    if len(digits) == 14:
        return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"
    return raw[:40]


def xlsx_column_index(reference):
    letters = "".join(ch for ch in str(reference or "") if ch.isalpha())
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch.upper()) - 64)
    return index - 1


def xlsx_reference(reference):
    match = re.match(r"([A-Za-z]+)(\d+)", str(reference or "").strip())
    if not match:
        return None, None
    return int(match.group(2)) - 1, xlsx_column_index(match.group(1))


def xlsx_serial_date(value):
    try:
        serial = float(value)
    except (TypeError, ValueError):
        return ""
    return (datetime(1899, 12, 30) + timedelta(days=serial)).strftime("%Y-%m-%d")


def xlsx_date_format(code):
    cleaned = re.sub(r"\[[^\]]*\]|\"[^\"]*\"", "", code or "").lower()
    return bool(re.search(r"(yy|dd|d/|m/|/m|/d)", cleaned))


def xlsx_shared_strings(package):
    shared = []
    if "xl/sharedStrings.xml" in package.namelist():
        root = ET.fromstring(package.read("xl/sharedStrings.xml"))
        for item in root.findall(f"{XLSX_NS}si"):
            shared.append("".join(node.text or "" for node in item.iter(f"{XLSX_NS}t")))
    return shared


def xlsx_date_style_ids(package):
    date_styles = set()
    if "xl/styles.xml" not in package.namelist():
        return date_styles
    root = ET.fromstring(package.read("xl/styles.xml"))
    formats = {}
    for node in root.iter(f"{XLSX_NS}numFmt"):
        try:
            formats[int(node.get("numFmtId"))] = node.get("formatCode") or ""
        except (TypeError, ValueError):
            continue
    xfs = root.find(f"{XLSX_NS}cellXfs")
    if xfs is not None:
        for index, node in enumerate(xfs.findall(f"{XLSX_NS}xf")):
            try:
                fmt_id = int(node.get("numFmtId") or 0)
            except ValueError:
                fmt_id = 0
            if fmt_id in range(14, 23) or fmt_id in (45, 46, 47) or xlsx_date_format(formats.get(fmt_id, "")):
                date_styles.add(index)
    return date_styles


def xlsx_sheet_entries(package):
    names = set(package.namelist())
    entries = []
    if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
        workbook = ET.fromstring(package.read("xl/workbook.xml"))
        rels = ET.fromstring(package.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        for sheet in workbook.findall(f"{XLSX_NS}sheets/{XLSX_NS}sheet"):
            target = targets.get(sheet.get(f"{XLSX_REL_NS}id"))
            if not target:
                continue
            target = str(target).lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            if path in names:
                entries.append((sheet.get("name") or f"Planilha {len(entries) + 1}", path))
    if entries:
        return entries
    candidates = sorted(name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"))
    return [(Path(name).stem, name) for name in candidates]


def xlsx_sheet_grid(package, sheet_path, shared, date_styles):
    root = ET.fromstring(package.read(sheet_path))
    cells = {}
    max_row = max_col = 0
    for row in root.iter(f"{XLSX_NS}row"):
        try:
            row_index = int(row.get("r")) - 1
        except (TypeError, ValueError):
            continue
        for cell in row.findall(f"{XLSX_NS}c"):
            col_index = xlsx_column_index(cell.get("r"))
            if col_index < 0:
                continue
            kind = cell.get("t") or "n"
            try:
                style = int(cell.get("s") or 0)
            except ValueError:
                style = 0
            value = ""
            if kind == "inlineStr":
                node = cell.find(f"{XLSX_NS}is")
                if node is not None:
                    value = "".join(part.text or "" for part in node.iter(f"{XLSX_NS}t"))
            else:
                node = cell.find(f"{XLSX_NS}v")
                raw = (node.text if node is not None else "") or ""
                if kind == "s":
                    try:
                        value = shared[int(raw)]
                    except (ValueError, IndexError):
                        value = ""
                elif kind == "b":
                    value = "Sim" if raw == "1" else "Não"
                elif kind in ("str", "d"):
                    value = raw
                else:
                    value = raw
                    if raw and style in date_styles:
                        value = xlsx_serial_date(raw)
            value = (value or "").strip()
            if value:
                cells[(row_index, col_index)] = value
            max_row = max(max_row, row_index + 1)
            max_col = max(max_col, col_index + 1)
    for merge in root.iter(f"{XLSX_NS}mergeCell"):
        reference = merge.get("ref") or ""
        if ":" not in reference:
            continue
        first, _, last = reference.partition(":")
        row_a, col_a = xlsx_reference(first)
        row_b, col_b = xlsx_reference(last)
        if row_a is None or row_b is None:
            continue
        value = cells.get((row_a, col_a))
        if not value:
            continue
        for row_index in range(row_a, max(row_a, row_b) + 1):
            for col_index in range(col_a, max(col_a, col_b) + 1):
                cells.setdefault((row_index, col_index), value)
        max_row = max(max_row, row_b + 1)
        max_col = max(max_col, col_b + 1)
    return cells, max_row, max_col


def xlsx_read_grid(data):
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        entries = xlsx_sheet_entries(package)
        if not entries:
            raise ValueError("A planilha não tem nenhuma aba legível.")
        return xlsx_sheet_grid(package, entries[0][1], xlsx_shared_strings(package), xlsx_date_style_ids(package))


def xlsx_read_workbook(data):
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        entries = xlsx_sheet_entries(package)
        if not entries:
            raise ValueError("A planilha não tem nenhuma aba legível.")
        shared = xlsx_shared_strings(package)
        date_styles = xlsx_date_style_ids(package)
        sheets = []
        for name, path in entries:
            try:
                sheets.append((name, *xlsx_sheet_grid(package, path, shared, date_styles)))
            except (KeyError, ET.ParseError):
                continue
        return sheets


def xlsx_rows(cells, max_row, max_col):
    return [
        [(col, cells[(row, col)]) for col in range(max_col) if (row, col) in cells]
        for row in range(max_row)
    ]


# ── Financeiro: rateios recebidos do P4X ────────────────────────────────────
FINANCE_MAX_UPLOAD = 80_000_000
FINANCE_DATE_COLUMNS = {
    "payment": "payment_date",
    "due": "due_date",
    "credit": "credit_date",
    "rateio": "rateio_date",
}
FINANCE_SORTS = {
    "payment_desc": "ORDER BY (payment_date = '') ASC, payment_date DESC, file_name ASC, payer_name ASC",
    "payment_asc": "ORDER BY (payment_date = '') ASC, payment_date ASC, file_name ASC, payer_name ASC",
    "rateio_desc": "ORDER BY rateio DESC, payment_date DESC, payer_name ASC",
    "rateio_asc": "ORDER BY rateio ASC, payment_date DESC, payer_name ASC",
    "payer": "ORDER BY payer_name COLLATE NOCASE ASC, payment_date DESC",
    "file": "ORDER BY file_name COLLATE NOCASE ASC, payer_name ASC",
}
FINANCE_COLUMNS = (
    ("occurrence", ("descricao da ocorrencia",)),
    ("occurrence_code", ("codigo da ocorrencia",)),
    ("payer_name", ("nome do pagador",)),
    ("payer_doc", ("cpf cnpj do pagador", "cpf/cnpj do pagador")),
    ("our_number", ("nosso numero",)),
    ("your_number", ("seu numero",)),
    ("nominal", ("valor nominal",)),
    ("fee", ("valor tarifa",)),
    ("paid", ("valor pago",)),
    ("rateio", ("valor rateio",)),
    ("due_date", ("data do vencimento",)),
    ("payment_date", ("data do pagamento",)),
    ("credit_date", ("data do credito",)),
    ("rateio_date", ("data do rateio",)),
    ("receiver_name", ("recebedor", "nome do recebedor")),
    ("receiver_doc", ("cpf cnpj do recebedor", "cpf/cnpj do recebedor")),
)
FINANCE_MONEY_FIELDS = ("nominal", "fee", "paid", "rateio")


def finance_text_key(value):
    normalized = unicodedata.normalize("NFKD", str(value or "").strip().lower())
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def finance_money(value):
    raw = str(value or "").strip()
    if not raw:
        return 0.0
    if "," in raw and "." in raw:
        raw = raw.replace(".", "").replace(",", ".") if raw.rfind(",") > raw.rfind(".") else raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(",", ".")
    raw = re.sub(r"[^0-9.\-]", "", raw)
    try:
        return round(float(raw), 2)
    except ValueError:
        return 0.0


def finance_date_value(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw[:10]):
        return raw[:10]
    match = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if match:
        return f"{match.group(3)}-{match.group(2).zfill(2)}-{match.group(1).zfill(2)}"
    if re.fullmatch(r"\d{5}(\.\d+)?", raw):
        serial = float(raw)
        if 20000 <= serial <= 80000:
            return xlsx_serial_date(serial)
    return ""


def finance_header_map(row):
    mapping = {}
    for col, text in row:
        key = finance_text_key(text)
        if not key:
            continue
        for field, aliases in FINANCE_COLUMNS:
            if field in mapping:
                continue
            for alias in aliases:
                if key == alias or (len(alias) >= 8 and alias in key):
                    mapping[field] = col
                    break
    required = {"payer_name", "rateio"} & set(mapping)
    return mapping if len(mapping) >= 6 and required else None


def finance_sheet_records(sheet_name, cells, max_row, max_col):
    rows = xlsx_rows(cells, max_row, max_col)
    header_index = None
    mapping = None
    for index, row in enumerate(rows[:60]):
        candidate = finance_header_map(row)
        if candidate:
            header_index, mapping = index, candidate
            break
    if header_index is None:
        return []
    file_ref = ""
    for row in rows[:header_index]:
        for _col, text in row:
            match = re.match(r"Arquivo:\s*(.+)", str(text or ""), re.IGNORECASE)
            if match:
                file_ref = match.group(1).strip()
                break
        if file_ref:
            break
    file_name = re.sub(r"\.txt$", "", file_ref, flags=re.IGNORECASE).strip() or str(sheet_name or "").strip()
    records = []
    for row in rows[header_index + 1:]:
        by_col = {col: str(text or "").strip() for col, text in row}
        record = {field: by_col.get(mapping.get(field), "") for field, _aliases in FINANCE_COLUMNS}
        if not any(record[key] for key in ("payer_name", "payer_doc", "our_number", "your_number")):
            continue
        for field in FINANCE_MONEY_FIELDS:
            record[field] = finance_money(record[field])
        for field in ("due_date", "payment_date", "credit_date", "rateio_date"):
            record[field] = finance_date_value(record[field])
        if not any(record[field] for field in FINANCE_MONEY_FIELDS):
            continue
        record["sheet_name"] = str(sheet_name or "")
        record["file_name"] = file_name
        records.append(record)
    return records


def finance_parse_workbook(data, fallback_name):
    if not data:
        raise ValueError("Envie o arquivo do consolidado de rateios.")
    if len(data) > FINANCE_MAX_UPLOAD:
        raise ValueError("O arquivo deve ter no máximo 80 MB.")
    try:
        sheets = xlsx_read_workbook(data)
    except (zipfile.BadZipFile, KeyError, ET.ParseError, ValueError) as exc:
        raise ValueError("Não consegui ler esta planilha. Envie o .xlsx gerado pela extensão.") from exc
    records = []
    seen = set()
    ignored = 0
    for sheet_name, cells, max_row, max_col in sheets:
        sheet_records = finance_sheet_records(sheet_name, cells, max_row, max_col)
        if not sheet_records:
            ignored += 1
            continue
        for record in sheet_records:
            dedupe_key = (
                record["file_name"], record["receiver_name"], record["receiver_doc"],
                record["occurrence_code"], record["payer_doc"] or record["payer_name"],
                record["our_number"], record["your_number"],
                record["nominal"], record["rateio"], record["due_date"],
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            records.append(record)
    if not records:
        raise ValueError(
            "Nenhum lançamento de rateio foi encontrado. Confira se o arquivo é o consolidado "
            "exportado pela extensão do P4X."
        )
    fallback = re.sub(r"\.xlsx?$", "", str(fallback_name or "")).strip() or "Consolidado P4X"
    for record in records:
        record["file_name"] = record["file_name"] or fallback
    return {"records": records, "ignoredSheets": ignored, "sheets": len(sheets)}


def finance_import_payload(row):
    keys = row.keys()
    return {
        "id": row["id"],
        "fileName": row["file_name"],
        "userId": row["user_id"],
        "userName": row["user_name"],
        "source": row["source"] if "source" in keys else "planilha",
        "rows": row["rows_count"],
        "files": row["files_count"],
        "receivers": row["receivers_count"],
        "nominal": row["total_nominal"],
        "fee": row["total_fee"],
        "paid": row["total_paid"],
        "rateio": row["total_rateio"],
        "periodStart": row["period_start"],
        "periodEnd": row["period_end"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
    }


def finance_rateio_payload(row):
    return {
        "id": row["id"],
        "importId": row["import_id"],
        "sheet": row["sheet_name"],
        "file": row["file_name"],
        "receiver": row["receiver_name"],
        "receiverDoc": row["receiver_doc"],
        "occurrence": row["occurrence"],
        "occurrenceCode": row["occurrence_code"],
        "payer": row["payer_name"],
        "payerDoc": row["payer_doc"],
        "ourNumber": row["our_number"],
        "yourNumber": row["your_number"],
        "nominal": row["nominal"],
        "fee": row["fee"],
        "paid": row["paid"],
        "rateio": row["rateio"],
        "dueDate": row["due_date"],
        "paymentDate": row["payment_date"],
        "creditDate": row["credit_date"],
        "rateioDate": row["rateio_date"],
    }


def finance_store_import(db, parsed, file_name, file_hash, user):
    records = parsed["records"]
    replaced = None
    if file_hash:
        existing = db.execute("SELECT * FROM finance_imports WHERE file_hash = ?", (file_hash,)).fetchone()
        if existing:
            db.execute("DELETE FROM finance_rateios WHERE import_id = ?", (existing["id"],))
            db.execute("DELETE FROM finance_imports WHERE id = ?", (existing["id"],))
            replaced = existing
    import_id = str(uuid.uuid4())
    created_at = now_iso()
    dates = [record["payment_date"] or record["due_date"] for record in records]
    dates = sorted(value for value in dates if value)
    files = {record["file_name"] for record in records if record["file_name"]}
    receivers = {record["receiver_name"] for record in records if record["receiver_name"]}
    totals = {field: round(sum(record[field] for record in records), 2) for field in FINANCE_MONEY_FIELDS}
    db.execute(
        """INSERT INTO finance_imports(
               id, file_name, file_hash, user_id, user_name, source, rows_count,
               files_count, receivers_count, total_nominal, total_fee, total_paid,
               total_rateio, period_start, period_end, notes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            import_id, file_name, file_hash, user["id"], user["display_name"], "planilha",
            len(records), len(files), len(receivers), totals["nominal"], totals["fee"],
            totals["paid"], totals["rateio"], dates[0] if dates else "",
            dates[-1] if dates else "", "", created_at,
        ),
    )
    db.executemany(
        """INSERT INTO finance_rateios(
               id, import_id, sheet_name, file_name, receiver_name, receiver_doc,
               occurrence, occurrence_code, payer_name, payer_doc, our_number, your_number,
               nominal, fee, paid, rateio, due_date, payment_date, credit_date,
               rateio_date, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                str(uuid.uuid4()), import_id, record["sheet_name"], record["file_name"],
                record["receiver_name"], record["receiver_doc"], record["occurrence"],
                record["occurrence_code"], record["payer_name"], record["payer_doc"],
                record["our_number"], record["your_number"], record["nominal"], record["fee"],
                record["paid"], record["rateio"], record["due_date"], record["payment_date"],
                record["credit_date"], record["rateio_date"], created_at,
            )
            for record in records
        ],
    )
    return import_id, replaced


def finance_filters_from_query(query):
    clauses = []
    params = []
    search = (query.get("search") or [""])[0].strip()
    if search:
        like = f"%{search}%"
        clauses.append(
            "(payer_name LIKE ? OR payer_doc LIKE ? OR our_number LIKE ? OR your_number LIKE ? "
            "OR file_name LIKE ? OR receiver_name LIKE ? OR occurrence LIKE ?)"
        )
        params.extend([like] * 7)
    file_filter = (query.get("file") or [""])[0].strip()
    if file_filter:
        clauses.append("file_name = ?")
        params.append(file_filter)
    receiver_filter = (query.get("receiver") or [""])[0].strip()
    if receiver_filter:
        clauses.append("receiver_name = ?")
        params.append(receiver_filter)
    occurrence_filter = (query.get("occurrence") or [""])[0].strip()
    if occurrence_filter:
        clauses.append("occurrence = ?")
        params.append(occurrence_filter)
    import_filter = (query.get("importId") or [""])[0].strip()
    if import_filter and import_filter != "all":
        clauses.append("import_id = ?")
        params.append(import_filter)
    date_column = FINANCE_DATE_COLUMNS.get((query.get("dateField") or ["payment"])[0], "payment_date")
    start = finance_date_value((query.get("from") or [""])[0])
    if start:
        clauses.append(f"{date_column} != '' AND {date_column} >= ?")
        params.append(start)
    end = finance_date_value((query.get("to") or [""])[0])
    if end:
        clauses.append(f"{date_column} != '' AND {date_column} <= ?")
        params.append(end)
    return (" AND ".join(clauses) if clauses else "1=1"), params, date_column


def finance_summary(db, where, params, date_column):
    row = db.execute(
        f"""SELECT COUNT(*) AS n, COUNT(DISTINCT file_name) AS files,
                   COUNT(DISTINCT CASE WHEN receiver_name != '' THEN receiver_name END) AS receivers,
                   COALESCE(SUM(nominal), 0) AS nominal, COALESCE(SUM(fee), 0) AS fee,
                   COALESCE(SUM(paid), 0) AS paid, COALESCE(SUM(rateio), 0) AS rateio,
                   MIN(CASE WHEN {date_column} != '' THEN {date_column} END) AS period_start,
                   MAX(CASE WHEN {date_column} != '' THEN {date_column} END) AS period_end
            FROM finance_rateios WHERE {where}""",
        params,
    ).fetchone()
    return {
        "rows": row["n"],
        "files": row["files"],
        "receivers": row["receivers"],
        "nominal": round(row["nominal"], 2),
        "fee": round(row["fee"], 2),
        "paid": round(row["paid"], 2),
        "rateio": round(row["rateio"], 2),
        "periodStart": row["period_start"] or "",
        "periodEnd": row["period_end"] or "",
    }


def finance_filter_options(db):
    def values(column):
        return [
            row[column]
            for row in db.execute(
                f"SELECT DISTINCT {column} FROM finance_rateios WHERE {column} != '' ORDER BY {column} COLLATE NOCASE LIMIT 500"
            )
        ]

    return {
        "files": values("file_name"),
        "receivers": values("receiver_name"),
        "occurrences": values("occurrence"),
    }


def finance_xml_text(value):
    text = str(value or "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&apos;")
    )


def finance_column_letter(index):
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def finance_date_serial(value):
    raw = str(value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return None
    try:
        return (datetime.strptime(raw, "%Y-%m-%d").date() - date(1899, 12, 30)).days
    except ValueError:
        return None


def finance_cell_xml(reference, value, style=0):
    style_attr = f' s="{style}"' if style else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{reference}"{style_attr}><v>{value}</v></c>'
    text = str(value or "")
    if not text:
        return ""
    return f'<c r="{reference}" t="inlineStr"{style_attr}><is><t xml:space="preserve">{finance_xml_text(text)}</t></is></c>'


def finance_build_xlsx(records):
    columns = (
        ("file_name", "text"), ("receiver_name", "text"), ("receiver_doc", "text"),
        ("occurrence", "text"), ("occurrence_code", "text"), ("payer_name", "text"),
        ("payer_doc", "text"), ("our_number", "text"), ("your_number", "text"),
        ("nominal", "money"), ("fee", "money"), ("paid", "money"), ("rateio", "money"),
        ("due_date", "date"), ("payment_date", "date"), ("credit_date", "date"),
        ("rateio_date", "date"),
    )
    headers = (
        "Arquivo", "Recebedor", "CPF/CNPJ do recebedor", "Descrição da ocorrência",
        "Código da ocorrência", "Nome do pagador", "CPF/CNPJ do pagador", "Nosso número",
        "Seu número", "Valor nominal", "Valor tarifa", "Valor pago", "Valor rateio",
        "Data do vencimento", "Data do pagamento", "Data do crédito", "Data do rateio",
    )
    rows_xml = [
        '<row r="1">' + "".join(
            finance_cell_xml(f"{finance_column_letter(index)}1", header)
            for index, header in enumerate(headers)
        ) + "</row>"
    ]
    for row_index, record in enumerate(records, start=2):
        cells = []
        for col_index, (field, kind) in enumerate(columns):
            reference = f"{finance_column_letter(col_index)}{row_index}"
            value = record[field]
            if kind == "money":
                cells.append(finance_cell_xml(reference, round(float(value or 0), 2), 1))
            elif kind == "date":
                serial = finance_date_serial(value)
                cells.append(finance_cell_xml(reference, serial, 2) if serial is not None else finance_cell_xml(reference, value))
            else:
                cells.append(finance_cell_xml(reference, value))
        rows_xml.append(f'<row r="{row_index}">' + "".join(cells) + "</row>")
    last_reference = f"{finance_column_letter(len(headers) - 1)}{len(records) + 1}"
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{XLSX_NS[1:-1]}">'
        f'<dimension ref="A1:{last_reference}"/>'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        '<sheetData>' + "".join(rows_xml) + "</sheetData></worksheet>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{XLSX_NS[1:-1]}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Rateios" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{XLSX_NS[1:-1]}">'
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", root_rels)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        package.writestr("xl/styles.xml", styles_xml)
        package.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return buffer.getvalue()


FINANCE_CSV_CODE_RE = re.compile(r"[A-Z0-9]{6,40}")


def finance_csv_amount(value):
    try:
        amount = round(float(value or 0), 2)
    except (TypeError, ValueError):
        amount = 0.0
    whole, _, decimals = f"{amount:.2f}".partition(".")
    decimals = decimals.rstrip("0")
    if amount == 0:
        return "0"
    return f"{whole},{decimals}" if decimals else whole


def finance_csv_date(value):
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        year, month, day = raw.split("-")
        return f"{day}/{month}/{year}"
    return raw


def finance_csv_filename(name):
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", str(name or ""))
    clean = re.sub(r"\s+", " ", clean).strip(" .")
    if not clean:
        clean = "rateios"
    stem = clean[:-4] if clean.lower().endswith(".csv") else clean
    stem = stem[:150].rstrip(" .") or "rateios"
    return f"{stem}.csv"


def finance_build_csv(records, header_code):
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow([header_code, "", "", ""])
    writer.writerow(["NN", "Pagamento", "Valor", "data crédito"])
    for record in records:
        writer.writerow([
            str(record["our_number"] or "").strip(),
            finance_csv_date(record["payment_date"]),
            finance_csv_amount(record["paid"]),
            finance_csv_date(record["credit_date"]),
        ])
    return buffer.getvalue().encode("cp1252", errors="replace")


FINANCE_CSV_EMPTY_OCCURRENCE = "__empty__"


def finance_apply_occurrence_selection(where, params, values):
    names = []
    include_empty = False
    for value in values:
        if value == FINANCE_CSV_EMPTY_OCCURRENCE:
            include_empty = True
        elif value:
            names.append(value)
    clauses = []
    params = list(params)
    if names:
        clauses.append(f"occurrence IN ({', '.join('?' for _ in names)})")
        params.extend(names)
    if include_empty:
        clauses.append("occurrence = ''")
    if not clauses:
        return where, params
    return f"({where}) AND ({' OR '.join(clauses)})", params


def contract_label_field(text):
    norm = contract_key(text)
    if not norm:
        return None
    for field, aliases in CONTRACT_COMPANY_LABELS:
        for alias in aliases:
            alias_norm = contract_key(alias)
            if alias_norm and (norm == alias_norm or alias_norm in norm):
                return field
    return None


def contract_looks_like_label(text, col):
    raw = str(text or "").strip()
    if not raw:
        return None
    if ":" in raw:
        return contract_label_field(raw.split(":", 1)[0])
    if col <= 1 and not any(ch.isdigit() for ch in raw):
        norm = contract_key(raw)
        for field, aliases in CONTRACT_COMPANY_LABELS:
            if any(norm == contract_key(alias) for alias in aliases):
                return field
    return None


def contract_inline_value(text):
    raw = str(text or "")
    if ":" not in raw:
        return ""
    return raw.split(":", 1)[1].strip()


def contract_row_value(entries, start, skip_sublabels=False):
    for col, text in entries[start + 1:]:
        value = str(text or "").strip()
        if not value:
            continue
        norm = contract_key(value).rstrip(" :")
        if skip_sublabels and norm in ("nome", "email", "e mail"):
            continue
        if contract_looks_like_label(value, col):
            return ""
        return value
    return ""


def contract_accountant_values(entries):
    name = ""
    email = ""
    for index, (col, text) in enumerate(entries):
        norm = contract_key(text).rstrip(" :")
        if norm == "nome":
            value = contract_inline_value(text) or contract_row_value(entries, index, skip_sublabels=True)
            if value:
                name = value
        elif norm in ("email", "e mail"):
            value = contract_inline_value(text) or contract_row_value(entries, index, skip_sublabels=True)
            if value:
                email = value
    return name, email


def contract_life_header(cells):
    mapping = {}
    for col, text in cells:
        norm = contract_key(text)
        if not norm:
            continue
        for field, aliases in CONTRACT_LIFE_HEADERS:
            matched = False
            for alias in aliases:
                alias_norm = contract_key(alias)
                if norm == alias_norm or (field != "name" and alias_norm and alias_norm in norm):
                    mapping.setdefault(field, col)
                    matched = True
                    break
            if matched:
                break
    if "name" not in mapping and "name_alt" in mapping:
        mapping["name"] = mapping["name_alt"]
    return mapping if "name" in mapping and len(mapping) >= 3 else None


def contract_company_from_rows(rows):
    fields = {field: "" for field, _aliases in CONTRACT_COMPANY_LABELS}
    for cells in rows:
        has_accountant = any(contract_looks_like_label(text, col) == "accountant_name" for col, text in cells)
        for index, (col, text) in enumerate(cells):
            field = contract_looks_like_label(text, col)
            if not field:
                continue
            if field == "accountant_name" and has_accountant:
                inline = contract_inline_value(text)
                if inline:
                    fields["accountant_name"] = inline
                sub_name, sub_email = contract_accountant_values(cells)
                if sub_name:
                    fields["accountant_name"] = sub_name
                if sub_email:
                    fields["accountant_email"] = sub_email
                continue
            if fields.get(field):
                continue
            value = contract_inline_value(text) or contract_row_value(cells, index)
            if value:
                fields[field] = value
    fields["name"] = fields["name"].strip().strip(";").strip()[:160]
    fields["cnpj"] = contract_cnpj(fields["cnpj"])
    fields["contact_name"] = fields["contact_name"].strip().strip(";").strip()[:160]
    fields["phone"] = fields["phone"][:40]
    fields["email"] = fields["email"].lower()[:160]
    fields["accountant_name"] = fields["accountant_name"][:160]
    fields["accountant_email"] = fields["accountant_email"].lower()[:160]
    fields["plan"] = fields["plan"][:120]
    fields["seller"] = fields["seller"][:120]
    fields["contract_start"] = contract_date(fields["contract_start"])
    fields["notes"] = fields["notes"][:1000]
    fields["monthly_value"] = contract_money(fields["monthly_value"])
    return fields


def contract_lives_from_rows(rows, header_index, header_map):
    lives = []
    seen = set()
    name_col = header_map.get("name")
    alt_col = header_map.get("name_alt")
    for cells in rows[header_index + 1:]:
        by_col = {col: str(text or "").strip() for col, text in cells}
        name = (by_col.get(name_col) or by_col.get(alt_col) or "")[:160]
        if not name:
            continue
        if contract_key(name) in ("total", "totais", "subtotal", "nome", "nome completo"):
            continue
        life = {
            "name": name,
            "cpf": contract_cpf(by_col.get(header_map.get("cpf"), "")),
            "birth_date": contract_date(by_col.get(header_map.get("birth_date"), "")),
            "mother_name": by_col.get(header_map.get("mother_name"), "")[:160],
            "phone": by_col.get(header_map.get("phone"), "")[:40],
            "email": by_col.get(header_map.get("email"), "").lower()[:160],
            "role": by_col.get(header_map.get("role"), "")[:80],
            "notes": "",
        }
        if not any(life[key] for key in ("cpf", "birth_date", "mother_name", "phone", "email")):
            continue
        key = digits_only(life["cpf"]) or f"{contract_key(life['name'])}|{life['birth_date']}"
        if key in seen:
            continue
        seen.add(key)
        lives.append(life)
    return lives


def contract_parse_xlsx(data):
    if not data:
        raise ValueError("Envie o arquivo da planilha.")
    if len(data) > CONTRACT_MAX_UPLOAD:
        raise ValueError("A planilha deve ter no máximo 12 MB.")
    try:
        cells, max_row, max_col = xlsx_read_grid(data)
    except (zipfile.BadZipFile, KeyError, ET.ParseError, ValueError) as exc:
        raise ValueError("Não consegui ler esta planilha. Salve como .xlsx e tente novamente.") from exc
    rows = xlsx_rows(cells, max_row, max_col)
    header_index = None
    header_map = None
    for index, row in enumerate(rows):
        mapping = contract_life_header(row)
        if mapping:
            header_index, header_map = index, mapping
            break
    company_rows = rows[:header_index] if header_index is not None else rows
    company = contract_company_from_rows(company_rows)
    lives = contract_lives_from_rows(rows, header_index, header_map) if header_index is not None else []
    warnings = []
    if not company["name"]:
        raise ValueError("Não encontrei o nome da empresa na planilha. Use o modelo com o campo 'Nome da empresa'.")
    if not digits_only(company["cnpj"]):
        warnings.append("CNPJ não encontrado — vou identificar a empresa pelo nome.")
    if header_index is None:
        warnings.append("Não encontrei o cabeçalho dos colaboradores. A empresa será importada sem vidas.")
    elif not lives:
        warnings.append("O cabeçalho dos colaboradores foi encontrado, mas nenhuma vida foi preenchida.")
    return {"company": company, "lives": lives, "warnings": warnings}


COMMISSION_RATE = 0.4
CONTRACT_CLIENT_TYPES = ("Empresa", "Sindicato", "Associação", "Pessoa Física")


def contracts_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'contractsScreen'",
        (user["id"],),
    ).fetchone())


def commissions_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'commissionsScreen'",
        (user["id"],),
    ).fetchone())


def vidas_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'vidasScreen'",
        (user["id"],),
    ).fetchone())


def require_vidas(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not vidas_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à Movimentação de Vidas."}, 403)
        return None
    return user


def weekly_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'weeklyScreen'",
        (user["id"],),
    ).fetchone())


def require_weekly(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not weekly_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso ao Relatório Semanal."}, 403)
        return None
    return user


def require_retornos(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    allowed = user["role"] == "admin" or db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'retornosScreen'", (user["id"],)
    ).fetchone()
    if not allowed:
        handler.send_json({"error": "Você não tem acesso aos retornos das instituições financeiras."}, 403)
        return None
    return user


def require_contracts(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not contracts_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela de contratos."}, 403)
        return None
    return user


def ensure_contract_events_schema(db):
    # Deliberately no backfill or cascading FK: only new creations become events,
    # and deleting a company must not remove its persistent sequence/dedup record.
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL CHECK (event_type = 'contract_created'),
            created_at TEXT NOT NULL
        )"""
    )


def contract_record_created(db, company_id, created_at):
    # Caller owns the company transaction; never commit the event separately.
    db.execute(
        """INSERT INTO contract_events(company_id, event_type, created_at)
           VALUES (?, 'contract_created', ?) ON CONFLICT(company_id) DO NOTHING""",
        (company_id, created_at),
    )


def contract_events_page(db, query):
    def number(name, default, maximum):
        values = query.get(name, [str(default)])
        if len(values) != 1 or not re.fullmatch(r"[0-9]{1,16}", values[0]):
            raise ValueError(f"Parâmetro {name} inválido.")
        value = int(values[0])
        if value > maximum or (name == "limit" and value < 1):
            raise ValueError(f"Parâmetro {name} inválido.")
        return value

    limit = number("limit", 100, 100)
    latest = db.execute("SELECT COALESCE(MAX(id), 0) FROM contract_events").fetchone()[0]
    if "after" not in query:
        return {"events": [], "cursor": latest, "hasMore": False, "baseline": True}
    after = number("after", 0, 9_007_199_254_740_991)
    if after > latest:
        # A restored/replaced database needs a quiet fresh baseline too.
        return {"events": [], "cursor": latest, "hasMore": False, "baseline": True}
    rows = db.execute(
        "SELECT id, event_type, created_at FROM contract_events WHERE id > ? ORDER BY id LIMIT ?",
        (after, limit + 1),
    ).fetchall()
    events = [
        {"id": row["id"], "type": row["event_type"], "createdAt": row["created_at"]}
        for row in rows[:limit]
    ]
    return {
        "events": events, "cursor": events[-1]["id"] if events else after,
        "hasMore": len(rows) > limit, "baseline": False,
    }


def ensure_contract_registration_schema(db):
    # Snapshot columns keep a seller's history correct even if the company is
    # renamed or re-assigned after the registration status changed.
    db.execute(
        """CREATE TABLE IF NOT EXISTS contract_registration_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id TEXT NOT NULL,
            company_name TEXT NOT NULL DEFAULT '',
            seller_key TEXT NOT NULL DEFAULT '',
            registered INTEGER NOT NULL,
            actor TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS contract_registration_events_company ON contract_registration_events(company_id)"
    )


def contract_registration_record(db, company, registered, actor, created_at):
    # Caller owns the company transaction; the event never commits by itself.
    db.execute(
        """INSERT INTO contract_registration_events(
            company_id, company_name, seller_key, registered, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)""",
        (
            company["id"], company["name"], contract_key(company["seller"]),
            1 if registered else 0, str(actor or "")[:160], created_at,
        ),
    )


def contract_registration_events_page(db, query, seller_key=None):
    def number(name, default, maximum):
        values = query.get(name, [str(default)])
        if len(values) != 1 or not re.fullmatch(r"[0-9]{1,16}", values[0]):
            raise ValueError(f"Parâmetro {name} inválido.")
        value = int(values[0])
        if value > maximum or (name == "limit" and value < 1):
            raise ValueError(f"Parâmetro {name} inválido.")
        return value

    limit = number("limit", 100, 100)
    latest = db.execute("SELECT COALESCE(MAX(id), 0) FROM contract_registration_events").fetchone()[0]
    if "after" not in query:
        return {"events": [], "cursor": latest, "hasMore": False, "baseline": True}
    after = number("after", 0, 9_007_199_254_740_991)
    if after > latest:
        # A restored/replaced database needs a quiet fresh baseline too.
        return {"events": [], "cursor": latest, "hasMore": False, "baseline": True}
    sql = """SELECT id, company_id, company_name, registered, created_at
             FROM contract_registration_events WHERE id > ?"""
    params = [after]
    if seller_key is not None:
        sql += " AND seller_key = ?"
        params.append(seller_key)
    rows = db.execute(sql + " ORDER BY id LIMIT ?", (*params, limit + 1)).fetchall()
    events = [
        {
            "id": row["id"],
            "companyId": row["company_id"],
            "companyName": row["company_name"],
            "registered": bool(row["registered"]),
            "createdAt": row["created_at"],
        }
        for row in rows[:limit]
    ]
    return {
        "events": events, "cursor": events[-1]["id"] if events else after,
        "hasMore": len(rows) > limit, "baseline": False,
    }


def require_commissions(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not commissions_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela de comissões."}, 403)
        return None
    return user


def finance_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'financeScreen'",
        (user["id"],),
    ).fetchone())


def require_finance(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not finance_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela Financeiro."}, 403)
        return None
    return user


def require_lives_access(db, handler, company_id):
    """Contratos veem tudo; comissões só os próprios contratos e sem marcar cadastro."""
    user = require_user(db, handler)
    if not user:
        return None, False
    if contracts_allowed(db, user):
        return user, True
    if commissions_allowed(db, user):
        company = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
        if not company:
            handler.send_json({"error": "Empresa não encontrada."}, 404)
            return None, False
        if not company_in_scope(company, commission_scope(db, user)):
            handler.send_json({"error": "Você só pode acessar os seus contratos."}, 403)
            return None, False
        return user, False
    handler.send_json({"error": "Você não tem acesso às vidas dos contratos."}, 403)
    return None, False


def user_seller_name(user):
    stored = str(user["seller_name"] or "").strip() if "seller_name" in user.keys() else ""
    return stored or str(user["display_name"] or "").strip()


def user_seller_key(user):
    return contract_key(user_seller_name(user))


def can_edit_contract_values(db, user):
    return is_manager(user) or commissions_allowed(db, user)


def contract_company_payload(row, lives=0, birthdays=0, show_values=False, registered=0):
    registered = max(0, min(int(registered or 0), int(lives or 0)))
    payload = {
        "id": row["id"],
        "name": row["name"],
        "cnpj": row["cnpj"],
        "contactName": row["contact_name"],
        "phone": row["phone"],
        "email": row["email"],
        "accountantName": row["accountant_name"],
        "accountantEmail": row["accountant_email"],
        "plan": row["plan"],
        "seller": row["seller"],
        "clientType": (row["client_type"] if "client_type" in row.keys() else "") or "Empresa",
        "contractStart": row["contract_start"],
        "status": row["status"],
        "notes": row["notes"],
        "sourceFile": row["source_file"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "importedAt": row["imported_at"],
        "livesCount": lives,
        "registeredCount": registered,
        "pendingCount": max(0, int(lives or 0) - registered),
        "birthdaysMonth": birthdays,
        "companyRegistered": bool(row["registered"]) if "registered" in row.keys() else False,
        "companyRegisteredAt": (row["registered_at"] if "registered_at" in row.keys() else "") or "",
        "companyRegisteredBy": (row["registered_by"] if "registered_by" in row.keys() else "") or "",
    }
    if show_values:
        initial_lives = row["initial_lives"] if "initial_lives" in row.keys() else 0
        monthly = float(row["monthly_value"] or 0)
        payload["monthlyValue"] = monthly
        payload["valuePerLife"] = float(row["value_per_life"] or 0) if "value_per_life" in row.keys() else 0
        payload["initialLives"] = initial_lives or lives
        payload["initialCommission"] = round(monthly * COMMISSION_RATE, 2)
    return payload


def contract_life_payload(row):
    return {
        "id": row["id"],
        "companyId": row["company_id"],
        "name": row["name"],
        "cpf": row["cpf"],
        "birthDate": row["birth_date"],
        "motherName": row["mother_name"],
        "phone": row["phone"],
        "email": row["email"],
        "role": row["role"],
        "notes": row["notes"],
        "registered": bool(row["registered"]) if "registered" in row.keys() else False,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def contract_company_view(db, company_id, show_values=False):
    row = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
    if not row:
        return None, []
    lives = db.execute(
        "SELECT * FROM contract_lives WHERE company_id = ? ORDER BY lower(name), name",
        (company_id,),
    ).fetchall()
    month = date.today().month
    birthdays = sum(1 for life in lives if len(life["birth_date"] or "") >= 7 and life["birth_date"][5:7].isdigit() and int(life["birth_date"][5:7]) == month)
    registered = sum(1 for life in lives if "registered" in life.keys() and life["registered"])
    return contract_company_payload(row, len(lives), birthdays, show_values, registered), [contract_life_payload(life) for life in lives]


def contract_movement_payload(row):
    return {
        "id": row["id"],
        "companyId": row["company_id"],
        "monthNumber": row["month_number"],
        "livesAdded": row["lives_added"],
        "valuePerLife": row["value_per_life"],
        "totalMonth": row["total_month"],
        "commission": row["commission"],
        "note": row["note"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def commission_company_payload(db, row):
    lives_count = db.execute("SELECT COUNT(*) AS n FROM contract_lives WHERE company_id = ?", (row["id"],)).fetchone()["n"]
    registered_count = db.execute(
        "SELECT COUNT(*) AS n FROM contract_lives WHERE company_id = ? AND registered = 1",
        (row["id"],),
    ).fetchone()["n"]
    movements = db.execute(
        "SELECT * FROM contract_movements WHERE company_id = ? ORDER BY month_number, created_at",
        (row["id"],),
    ).fetchall()
    initial_lives = (row["initial_lives"] if "initial_lives" in row.keys() else 0) or lives_count
    value_per_life = float(row["value_per_life"] or 0) if "value_per_life" in row.keys() else 0
    initial_total = float(row["monthly_value"] or 0) or round(value_per_life * initial_lives, 2)
    initial_commission = round(initial_total * COMMISSION_RATE, 2)
    movement_total = round(sum(float(item["total_month"] or 0) for item in movements), 2)
    movement_commission = round(sum(float(item["commission"] or 0) for item in movements), 2)
    movement_lives = sum(int(item["lives_added"] or 0) for item in movements)
    return {
        "id": row["id"],
        "name": row["name"],
        "cnpj": row["cnpj"],
        "contactName": row["contact_name"],
        "phone": row["phone"],
        "email": row["email"],
        "clientType": (row["client_type"] if "client_type" in row.keys() else "") or "Empresa",
        "plan": row["plan"],
        "seller": row["seller"],
        "sellerKey": contract_key(row["seller"]),
        "contractStart": row["contract_start"],
        "status": row["status"],
        "notes": row["notes"],
        "initialLives": initial_lives,
        "valuePerLife": value_per_life,
        "initialTotal": round(initial_total, 2),
        "initialCommission": initial_commission,
        "movements": [contract_movement_payload(item) for item in movements],
        "movementLives": movement_lives,
        "movementTotal": movement_total,
        "movementCommission": movement_commission,
        "totalLives": initial_lives + movement_lives,
        "totalRevenue": round(initial_total + movement_total, 2),
        "totalCommission": round(initial_commission + movement_commission, 2),
        "livesCount": lives_count,
        "registeredCount": registered_count,
        "pendingCount": max(0, lives_count - registered_count),
        "companyRegistered": bool(row["registered"]) if "registered" in row.keys() else False,
        "companyRegisteredAt": (row["registered_at"] if "registered_at" in row.keys() else "") or "",
        "companyRegisteredBy": (row["registered_by"] if "registered_by" in row.keys() else "") or "",
        "updatedAt": row["updated_at"],
    }


def commission_scope(db, user):
    """None = todos os contratos; caso contrário, só os do vendedor logado."""
    if is_manager(user):
        return None
    return user_seller_key(user)


def company_in_scope(row, seller_key):
    return seller_key is None or contract_key(row["seller"]) == seller_key


def contract_life_key(life):
    cpf_key = digits_only(life.get("cpf"))
    if cpf_key:
        return ("cpf", cpf_key)
    return ("name", contract_key(life.get("name")), str(life.get("birth_date") or ""))


def contract_company_updates(payload, allow_values=True):
    aliases = {
        "contactName": "contact_name",
        "accountantName": "accountant_name",
        "accountantEmail": "accountant_email",
        "monthlyValue": "monthly_value",
        "valuePerLife": "value_per_life",
        "initialLives": "initial_lives",
        "clientType": "client_type",
        "contractStart": "contract_start",
    }
    payload = {aliases.get(key, key): value for key, value in payload.items()}
    updates = {}
    value_fields = {"monthly_value", "value_per_life", "initial_lives"}
    for field in (
        "name", "cnpj", "contact_name", "phone", "email", "accountant_name",
        "accountant_email", "plan", "monthly_value", "value_per_life",
        "initial_lives", "seller", "client_type", "contract_start", "status", "notes",
    ):
        if field not in payload:
            continue
        if field in value_fields and not allow_values:
            continue
        value = payload.get(field)
        if field in ("monthly_value", "value_per_life"):
            updates[field] = contract_money(value)
        elif field == "initial_lives":
            try:
                updates[field] = max(0, min(1_000_000, int(float(value or 0))))
            except (TypeError, ValueError):
                updates[field] = 0
        elif field == "cnpj":
            updates["cnpj"] = contract_cnpj(value)
            updates["cnpj_key"] = digits_only(value)
        elif field == "status":
            updates[field] = value if value in ("ativo", "pausado", "encerrado") else "ativo"
        elif field == "client_type":
            updates[field] = value if value in CONTRACT_CLIENT_TYPES else "Empresa"
        elif field == "contract_start":
            updates[field] = contract_date(value)
        else:
            updates[field] = str(value or "").strip()[:400]
    if "name" in updates and not updates["name"]:
        raise ValueError("O nome da empresa não pode ficar vazio.")
    return updates


def contract_movement_values(payload, existing=None):
    month_current = existing["month_number"] if existing else 1
    lives_current = existing["lives_added"] if existing else 0
    value_current = existing["value_per_life"] if existing else 0
    try:
        month_number = int(float(payload.get("monthNumber", month_current) or month_current))
    except (TypeError, ValueError):
        month_number = month_current
    try:
        lives = int(float(payload.get("livesAdded", lives_current) or 0))
    except (TypeError, ValueError):
        lives = 0
    lives = max(0, min(1_000_000, lives))
    value = contract_money(payload.get("valuePerLife")) if "valuePerLife" in payload else float(value_current or 0)
    total = round(lives * value, 2)
    note = payload.get("note")
    if note is None:
        note = existing["note"] if existing else ""
    return {
        "month_number": max(1, min(3, month_number)),
        "lives_added": lives,
        "value_per_life": value,
        "total_month": total,
        "commission": round(total * COMMISSION_RATE, 2),
        "note": str(note or "").strip()[:400],
    }


def contract_create_company(db, payload, user):
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Informe o nome da empresa.")
    cnpj = contract_cnpj(payload.get("cnpj"))
    cnpj_key = digits_only(cnpj)
    if cnpj_key and db.execute("SELECT 1 FROM contract_companies WHERE cnpj_key = ?", (cnpj_key,)).fetchone():
        raise ValueError("Já existe uma empresa com este CNPJ.")
    now = now_iso()
    company_id = str(uuid.uuid4())
    seller = str(payload.get("seller") or "").strip()
    if not is_manager(user):
        seller = user_seller_name(user)
    db.execute(
        """INSERT INTO contract_companies(id, name, cnpj, cnpj_key, seller, source_file, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)""",
        (company_id, name[:160], cnpj, cnpj_key, seller[:120], now, now),
    )
    updates = contract_company_updates(payload, allow_values=can_edit_contract_values(db, user))
    updates.pop("name", None)
    updates.pop("cnpj", None)
    updates.pop("cnpj_key", None)
    updates["seller"] = seller[:120]
    updates["updated_at"] = now
    assignments = ", ".join(f"{field} = ?" for field in updates)
    db.execute(
        f"UPDATE contract_companies SET {assignments} WHERE id = ?",
        (*updates.values(), company_id),
    )
    contract_record_created(db, company_id, now)
    return db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()


def contract_life_updates(payload, allow_registered=False):
    updates = {}
    for field in ("name", "cpf", "birth_date", "mother_name", "phone", "email", "role", "notes"):
        if field not in payload:
            continue
        value = payload.get(field)
        if field == "cpf":
            updates["cpf"] = contract_cpf(value)
            updates["cpf_key"] = digits_only(value)
        elif field == "birth_date":
            updates[field] = contract_date(value)
        else:
            updates[field] = str(value or "").strip()[:400]
    if "name" in updates and not updates["name"]:
        raise ValueError("O nome da vida não pode ficar vazio.")
    if allow_registered and "registered" in payload:
        updates["registered"] = 1 if payload.get("registered") else 0
    return updates


def contract_import(db, parsed, file_name, user, replace_lives=False):
    company = parsed["company"]
    now = now_iso()
    cnpj_key = digits_only(company.get("cnpj"))
    existing = None
    if cnpj_key:
        existing = db.execute("SELECT * FROM contract_companies WHERE cnpj_key = ?", (cnpj_key,)).fetchone()
    if not existing:
        existing = db.execute(
            "SELECT * FROM contract_companies WHERE lower(trim(name)) = lower(trim(?))",
            (company["name"],),
        ).fetchone()
    if existing:
        company_id = existing["id"]
        updates = {}
        for field in (
            "name", "cnpj", "contact_name", "phone", "email", "accountant_name",
            "accountant_email", "plan", "seller", "contract_start", "notes",
        ):
            incoming = company.get(field) or ""
            if incoming:
                updates[field] = incoming
        if cnpj_key:
            updates["cnpj_key"] = cnpj_key
        if company.get("monthly_value"):
            updates["monthly_value"] = company["monthly_value"]
        if not existing["initial_lives"] and parsed["lives"]:
            updates["initial_lives"] = len(parsed["lives"])
        updates["source_file"] = file_name
        updates["imported_at"] = now
        updates["updated_at"] = now
        assignments = ", ".join(f"{field} = ?" for field in updates)
        db.execute(
            f"UPDATE contract_companies SET {assignments} WHERE id = ?",
            (*updates.values(), company_id),
        )
        companies_created = 0
        companies_updated = 1
    else:
        company_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO contract_companies(
                id, name, cnpj, cnpj_key, contact_name, phone, email, accountant_name,
                accountant_email, plan, monthly_value, seller, contract_start, status,
                notes, source_file, initial_lives, created_at, updated_at, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', ?, ?, ?, ?, ?, ?)""",
            (
                company_id, company["name"], company["cnpj"], cnpj_key, company["contact_name"],
                company["phone"], company["email"], company["accountant_name"],
                company["accountant_email"], company["plan"], company["monthly_value"],
                company["seller"], company["contract_start"], company["notes"], file_name,
                len(parsed["lives"]), now, now, now,
            ),
        )
        companies_created = 1
        companies_updated = 0
        contract_record_created(db, company_id, now)
    existing_lives = db.execute("SELECT * FROM contract_lives WHERE company_id = ?", (company_id,)).fetchall()
    by_cpf = {life["cpf_key"]: life for life in existing_lives if life["cpf_key"]}
    by_name = {
        (contract_key(life["name"]), life["birth_date"] or ""): life
        for life in existing_lives
    }
    matched_ids = set()
    lives_created = 0
    lives_updated = 0
    for life in parsed["lives"]:
        key = contract_life_key(life)
        if key[0] == "cpf":
            match = by_cpf.get(key[1])
        else:
            match = by_name.get((key[1], key[2]))
        if match:
            matched_ids.add(match["id"])
            updates = {}
            for field in ("name", "cpf", "birth_date", "mother_name", "phone", "email", "role", "notes"):
                incoming = life.get(field) or ""
                if incoming:
                    updates[field] = incoming
            if digits_only(life.get("cpf")):
                updates["cpf_key"] = digits_only(life["cpf"])
            if updates:
                updates["updated_at"] = now
                assignments = ", ".join(f"{field} = ?" for field in updates)
                db.execute(
                    f"UPDATE contract_lives SET {assignments} WHERE id = ?",
                    (*updates.values(), match["id"]),
                )
                lives_updated += 1
            continue
        life_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO contract_lives(
                id, company_id, name, cpf, cpf_key, birth_date, mother_name, phone,
                email, role, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                life_id, company_id, life["name"], life["cpf"], digits_only(life["cpf"]),
                life["birth_date"], life["mother_name"], life["phone"], life["email"],
                life["role"], life["notes"], now, now,
            ),
        )
        matched_ids.add(life_id)
        lives_created += 1
    lives_removed = 0
    if replace_lives:
        for life in existing_lives:
            if life["id"] not in matched_ids:
                db.execute("DELETE FROM contract_lives WHERE id = ?", (life["id"],))
                lives_removed += 1
    db.execute(
        """INSERT INTO contract_imports(
            id, company_id, company_name, file_name, user_id, user_name,
            companies_created, companies_updated, lives_created, lives_updated,
            lives_removed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            str(uuid.uuid4()), company_id, company["name"], file_name, user["id"],
            user["display_name"], companies_created, companies_updated, lives_created,
            lives_updated, lives_removed, now,
        ),
    )
    db.commit()
    return {
        "companyId": company_id,
        "companiesCreated": companies_created,
        "companiesUpdated": companies_updated,
        "livesCreated": lives_created,
        "livesUpdated": lives_updated,
        "livesRemoved": lives_removed,
    }



def empty_metrics():
    return {"total": 0, "open": 0, "done": 0, "overdue": 0, "today": 0, "week": 0, "recent": []}


def add_task_metrics(metrics, task, done, due, today, week_end, sector_names):
    metrics["total"] += 1
    if done:
        metrics["done"] += 1
        return
    metrics["open"] += 1
    if due and due < today:
        metrics["overdue"] += 1
    if due and due == today:
        metrics["today"] += 1
    if due and today <= due <= week_end:
        metrics["week"] += 1
    if len(metrics["recent"]) < 12:
        metrics["recent"].append({
            "id": str(task.get("id") or ""),
            "title": str(task.get("title") or ""),
            "due": due,
            "priority": str(task.get("priority") or "medium"),
            "sector": sector_names.get(task.get("sectorId") or "", ""),
        })


def task_metrics(db, my_name, sector_ids=None):
    sector_names = {row["id"]: row["name"] for row in db.execute("SELECT id, name FROM sectors")}
    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    state = json.loads(row["data"]) if row else {}
    today = date.today().isoformat()
    week_end = (date.today() + timedelta(days=7)).isoformat()
    my_key = normalize_name(my_name)
    owners, sectors = {}, {}
    totals = empty_metrics()
    for task in state.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        sector_id = str(task.get("sectorId") or "")
        if sector_ids is not None and sector_id not in sector_ids:
            continue
        done = str(task.get("status") or "todo") == "done"
        due = str(task.get("due") or task.get("periodEnd") or "")[:10]
        owner_key = normalize_name(task.get("owner"))
        if owner_key in ("eu", ""):
            owner_key = my_key
        add_task_metrics(totals, task, done, due, today, week_end, sector_names)
        if owner_key:
            add_task_metrics(owners.setdefault(owner_key, empty_metrics()), task, done, due, today, week_end, sector_names)
        if sector_id:
            add_task_metrics(sectors.setdefault(sector_id, empty_metrics()), task, done, due, today, week_end, sector_names)
    for metrics in (totals, *owners.values(), *sectors.values()):
        metrics["recent"].sort(key=lambda item: (item["due"] or "9999-12-31", item["title"].lower()))
        metrics["recent"] = metrics["recent"][:4]
    return owners, sectors, totals


def user_directory_index(db):
    users = []
    for row in db.execute("SELECT id, username, display_name, role, sector_id, birthday, photo, status_emoji, status_text, status_until FROM users ORDER BY display_name"):
        users.append({
            "id": row["id"],
            "username": row["username"],
            "name": row["display_name"],
            "role": row["role"],
            "sectorId": row["sector_id"] or "",
            "birthday": row["birthday"] or "",
            "photo": row["photo"] or "",
            "status": user_status(row),
        })
    by_name = {}
    for item in users:
        key = normalize_name(item["name"])
        if not key:
            continue
        current = by_name.get(key)
        if current is None or (not current["photo"] and item["photo"]):
            by_name[key] = item
    return users, by_name


def birthday_snapshot(db, users, by_name):
    linked, named = {}, {}

    def make_item(name, month, day, year, kind, photo):
        when, days_until, age = next_anniversary(month, day, year)
        return {
            "birthday": birthday_iso(month, day, year) or f"1900-{month:02d}-{day:02d}",
            "month": month,
            "day": day,
            "year": year,
            "nextDate": when.isoformat(),
            "daysUntil": days_until,
            "age": age,
            "kind": kind if kind in ("team", "partner") else "team",
            "photo": photo or "",
        }

    for row in db.execute("SELECT b.* FROM birthdays b"):
        match = by_name.get(normalize_name(row["name"]))
        item = make_item(row["name"], row["month"], row["day"], row["year"], row["kind"], (row["photo"] or "") or (match["photo"] if match else ""))
        if row["user_id"]:
            linked[row["user_id"]] = item
        key = normalize_name(row["name"])
        if key:
            named.setdefault(key, item)
    for person in users:
        key = normalize_name(person["name"])
        if person["id"] in linked or (key and key in named):
            continue
        raw = normalize_birthday(person["birthday"])
        if not raw:
            continue
        parsed = date.fromisoformat(raw)
        item = make_item(person["name"], parsed.month, parsed.day, parsed.year, "team", person["photo"])
        linked[person["id"]] = item
        if key:
            named.setdefault(key, item)
    return linked, named


def directory_payload(db, user):
    users, by_name = user_directory_index(db)
    birthdays_by_user, birthdays_by_name = birthday_snapshot(db, users, by_name)
    allowed_sectors = viewer_sector_ids(db, user)
    owner_metrics, sector_metrics, totals = task_metrics(db, user["display_name"], allowed_sectors)
    person_sectors = user_sector_map(db)

    def member_of(row):
        member = directory_member(row)
        if not member["photo"]:
            member["photo"] = by_name.get(normalize_name(member["name"]), {}).get("photo", "")
        return member

    people = []
    for person in users:
        key = normalize_name(person["name"])
        birthday = birthdays_by_user.get(person["id"]) or birthdays_by_name.get(key) or {}
        duplicate = by_name.get(key) or {}
        scope_id = "|".join(sorted([user["id"], person["id"]])) if person["id"] != user["id"] else ""
        last = chat_last_message(db, "direct", scope_id) if scope_id else None
        tasks_visible = allowed_sectors is None or bool(person_sectors.get(person["id"], set()) & allowed_sectors)
        people.append({
            "id": person["id"],
            "name": person["name"],
            "username": person["username"],
            "role": person["role"],
            "sectorId": person["sectorId"],
            "sector": sector_name(db, person["sectorId"]),
            "birthday": birthday.get("birthday") or "",
            "birthdayDay": birthday.get("day") or 0,
            "birthdayMonth": birthday.get("month") or 0,
            "birthdayNext": birthday.get("nextDate") or "",
            "birthdayDays": birthday.get("daysUntil"),
            "birthdayAge": birthday.get("age"),
            "birthdayKind": birthday.get("kind") or "",
            "photo": person["photo"] or duplicate.get("photo") or birthday.get("photo") or "",
            "status": person["status"],
            "tasks": (owner_metrics.get(key) or empty_metrics()) if tasks_visible else empty_metrics(),
            "tasksVisible": tasks_visible,
            "unread": chat_unread(db, user["id"], "direct", scope_id) if scope_id else 0,
            "lastMessage": last,
            "lastAt": last["createdAt"] if last else "",
        })
    everyone = [member_of(row) for row in db.execute("SELECT id, display_name, role, photo, status_emoji, status_text, status_until FROM users ORDER BY display_name")]
    team_last = chat_last_message(db, "team", "")
    groups = [{
        "scope": "team",
        "scopeId": "",
        "name": "Equipe",
        "description": "Canal com todos os perfis do portal.",
        "members": everyone,
        "memberCount": len(everyone),
        "tasks": totals,
        "tasksVisible": True,
        "tasksScope": "all" if allowed_sectors is None else "sector",
        "unread": chat_unread(db, user["id"], "team", ""),
        "lastMessage": team_last,
        "lastAt": team_last["createdAt"] if team_last else "",
    }]
    if is_manager(user):
        sector_rows = db.execute("SELECT * FROM sectors ORDER BY name").fetchall()
    else:
        sector_ids = sorted(allowed_sectors or ())
        sector_rows = db.execute(
            f"SELECT * FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name",
            sector_ids,
        ).fetchall() if sector_ids else []
    for sector in sector_rows:
        members = [
            member_of(row)
            for row in db.execute(
                """SELECT DISTINCT u.id, u.display_name, u.role, u.photo FROM users u
                   LEFT JOIN user_sectors us ON us.user_id = u.id
                   WHERE us.sector_id = ? OR u.sector_id = ?
                   ORDER BY u.display_name""",
                (sector["id"], sector["id"]),
            )
        ]
        last = chat_last_message(db, "sector", sector["id"])
        groups.append({
            "scope": "sector",
            "scopeId": sector["id"],
            "name": sector["name"],
            "description": sector["description"] or f"Canal do setor {sector['name']}.",
            "members": members,
            "memberCount": len(members),
            "tasks": sector_metrics.get(sector["id"]) or empty_metrics(),
            "tasksVisible": True,
            "tasksScope": "sector",
            "unread": chat_unread(db, user["id"], "sector", sector["id"]),
            "lastMessage": last,
            "lastAt": last["createdAt"] if last else "",
        })
    month = date.today().month
    summary = {
        "people": len(people),
        "groups": len(groups),
        "sectors": len({person["sectorId"] for person in people if person["sectorId"]}),
        "open": totals["open"],
        "overdue": totals["overdue"],
        "today": totals["today"],
        "scope": "all" if allowed_sectors is None else "sector",
        "birthdaysMonth": sum(1 for person in people if person["birthdayMonth"] == month),
    }
    return {"people": people, "groups": groups, "summary": summary, "me": user["id"]}


def filter_state_for_user(state, user, db):
    if user["role"] == "admin" or ("management" in user.keys() and user["management"]):
        return state
    sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
    if user["sector_id"] and user["sector_id"] not in sector_ids:
        sector_ids.append(user["sector_id"])
    tasks = state.get("tasks") or []
    state = dict(state)
    # Tarefas sem sectorId SÓ aparecem para admin/management — usuário comum só vê o seu setor
    state["tasks"] = [task for task in tasks if isinstance(task, dict) and task.get("sectorId") in sector_ids]
    return state


def merge_state(existing, incoming, user, db):
    merged = dict(existing)
    for key in ("billingHistory", "mergeRows", "learningData"):
        if key in incoming:
            merged[key] = incoming[key]
    manager = is_manager(user)
    sector_ids = [] if manager else user_sector_ids(db, user)
    existing_deleted = set(existing.get("deletedTaskIds") or [])
    incoming_deleted = set(incoming.get("deletedTaskIds") or [])
    incoming_tasks = incoming.get("tasks")
    if not manager:
        own_ids = {
            str(task.get("id"))
            for task in (existing.get("tasks") or [])
            if isinstance(task, dict) and task.get("id") and task.get("sectorId") in sector_ids
        }
        incoming_deleted &= own_ids
    deleted_ids = existing_deleted | incoming_deleted
    if incoming_tasks is None:
        merged["deletedTaskIds"] = sorted(deleted_ids)
        return merged
    if manager:
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
    existing_by_id = {str(task.get("id")): task for task in (existing.get("tasks") or []) if isinstance(task, dict) and task.get("id")}
    incoming_by_id = {str(task.get("id")): task for task in incoming_tasks if isinstance(task, dict) and task.get("id")}
    for task_id, task in incoming_by_id.items():
        if task_id in deleted_ids:
            continue
        item = dict(task)
        if item.get("sectorId") not in sector_ids:
            item["sectorId"] = user["sector_id"] or (sector_ids[0] if sector_ids else None)
        old = existing_by_id.get(task_id)
        if old is None:
            existing_by_id[task_id] = item
        else:
            if old.get("sectorId") in sector_ids:
                old_stamp = str(old.get("updatedAt") or old.get("createdAt") or "")
                new_stamp = str(item.get("updatedAt") or item.get("createdAt") or "")
                if new_stamp >= old_stamp:
                    existing_by_id[task_id] = item
    merged["tasks"] = [t for tid, t in existing_by_id.items() if tid not in deleted_ids]
    merged["deletedTaskIds"] = sorted(deleted_ids)
    return merged


def allowed_screens(role, assigned, management=False):
    extra = [screen for screen in assigned if screen not in DISABLED_SCREENS]
    if role == "admin":
        return ["*"]
    if management:
        extra += ["contractsScreen", "commissionsScreen", "financeScreen", "cobrancaScreen", "apuracaoScreen", "recibosScreen"]
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
    if row and "active" in row.keys() and not row["active"]:
        return None
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


SYSTEM_LOCK_OPEN_PATHS = ("/api/system/status", "/api/system/unlock")


def system_lock_state(db):
    rows = {
        row["key"]: row["value"]
        for row in db.execute(
            "SELECT key, value FROM meta WHERE key IN ('system_lock', 'system_lock_message', 'system_lock_since')"
        )
    }
    return (
        rows.get("system_lock") == "1",
        rows.get("system_lock_message", ""),
        rows.get("system_lock_since", ""),
    )


def deny_if_locked(handler, path):
    if path in SYSTEM_LOCK_OPEN_PATHS:
        return False
    if not (path.startswith("/api/") or path.startswith("/media/")):
        return False
    with connection() as db:
        locked, message, _since = system_lock_state(db)
    if not locked:
        return False
    handler.send_json(
        {"error": message or "O portal está bloqueado pela administração.", "locked": True},
        423,
    )
    return True


def set_user_screens(db, user_id, screen_ids):
    valid = {row["id"] for row in db.execute("SELECT id FROM screens")} - DISABLED_SCREENS
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


COBRANCA_ACTIVE_STATUSES = ("aberto", "em_cobranca", "promessa", "sem_contato")
COBRANCA_STATUS_LABELS = {
    "aberto": "Em aberto",
    "em_cobranca": "Em cobrança",
    "promessa": "Prometeu pagar",
    "sem_contato": "Sem contato",
    "pago": "Baixado",
    "encerrado": "Encerrado",
}
COBRANCA_TIPO_LABELS = {
    "PARTICULAR": "Mensalidade",
    "PLANO": "Mensalidade (plano)",
    "ACORDO": "Acordo",
    "CO-PARTICIPACAO": "Coparticipação",
    "CO-PARTICIPAÇÃO": "Coparticipação",
    "ADESAO": "Adesão",
    "ADESÃO": "Adesão",
    "COBRANCA": "Cobrança",
    "COBRANÇA": "Cobrança",
    "COMPLEMENTACAO": "Complementação",
    "COMPLEMENTAÇÃO": "Complementação",
    "FATURA DESMEMBRADA": "Fatura desmembrada",
    "MULTA CONTRATUAL": "Multa contratual",
    "OUTROS VALORES": "Outros valores",
    "CREDITO PRE-PAGO": "Crédito pré-pago",
    "CRÉDITO PRÉ-PAGO": "Crédito pré-pago",
    "COMPRA DE CREDITO": "Compra de crédito",
    "COMPRA DE CRÉDITO": "Compra de crédito",
    "SINDICATO": "Sindicato",
    "DIF MENSALIDADE": "Diferença de mensalidade",
    "ESTORNO": "Estorno",
}
COBRANCA_RESULT_LABELS = {
    "enviado": "Cobrança enviada",
    "prometeu": "Prometeu pagar",
    "sem_resposta": "Sem resposta",
    "contato_invalido": "E-mail/telefone inválido",
    "negociou": "Negociou acordo",
    "pagou": "Pagou",
    "outro": "Outro",
}
COBRANCA_SMTP_KEY = "cobranca_smtp"
COBRANCA_GRAPH_KEY = "cobranca_graph"
# Cliente público "Microsoft Graph Command Line Tools": permite login por código
# de dispositivo sem registro no tenant, então funciona sem administrador.
COBRANCA_GRAPH_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
COBRANCA_GRAPH_SCOPES = "https://graph.microsoft.com/Mail.Send offline_access openid profile"
COBRANCA_GRAPH_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0"
COBRANCA_LOTE_KEY = "cobranca_lote_texto"
COBRANCA_GROUP_CC_KEY = "cobranca_grupo_cc"
# Contatos internos da Rede Saúde não entram como destinatário nem em cópia.
COBRANCA_INTERNAL_EMAIL_HINTS = ("redesaude",)
COBRANCA_LOTE_LIMIT = 300
_cobranca_inflight = set()
_cobranca_inflight_lock = threading.Lock()
COBRANCA_BULK_SUBJECT = "Valores em aberto — {{empresa}}"
COBRANCA_BULK_BODY = (
    "Olá, {{empresa}}!\n\n"
    "Estamos entrando em contato sobre os valores em aberto abaixo:\n\n"
    "{{titulos}}\n\n"
    "Total em aberto: {{total}}\n\n"
    "Se o pagamento já foi feito, por favor desconsidere este e-mail e nos envie o comprovante. "
    "Em caso de dúvida, responda esta mensagem que verificamos juntos.\n\n"
    "Atenciosamente,\nRede Saúde"
)
COBRANCA_DEFAULT_TEMPLATES = (
    (
        "email-mensalidade",
        "Mensalidade em atraso (e-mail)",
        "email",
        "PARTICULAR",
        "Mensalidade em atraso — {{competencia}}",
        "Olá, {{primeiro_nome}}.\n\n"
        "Identificamos que a mensalidade de {{competencia}} está em aberto desde {{vencimento}} "
        "({{dias}} dias em atraso), no valor de {{valor}}.\n\n"
        "Caso o pagamento já tenha sido feito, por favor envie o comprovante respondendo este e-mail. "
        "Se ainda não pagou, responda esta mensagem que combinamos a melhor forma de regularizar.\n\n"
        "Atenciosamente,\nEquipe de Cobrança — Rede Saúde",
    ),
    (
        "whatsapp-mensalidade",
        "Mensalidade em atraso (WhatsApp)",
        "whatsapp",
        "PARTICULAR",
        "",
        "Olá, {{primeiro_nome}}! Aqui é da Rede Saúde.\n"
        "Identificamos a mensalidade de {{competencia}} em aberto desde {{vencimento}} "
        "({{dias}} dias), no valor de {{valor}}.\n\n"
        "Se já pagou, pode enviar o comprovante por aqui. Se precisar, vemos juntos a melhor forma de regularizar.",
    ),
    (
        "email-acordo",
        "Parcela de acordo em atraso (e-mail)",
        "email",
        "ACORDO",
        "Parcela do acordo em atraso — {{parcela}}",
        "Olá, {{primeiro_nome}}.\n\n"
        "Consta em aberto a parcela {{parcela}} do seu acordo, com vencimento em {{vencimento}} "
        "({{dias}} dias em atraso), no valor de {{valor}}.\n\n"
        "Para manter o acordo ativo, é importante regularizar esta parcela. Responda este e-mail "
        "que combinamos a melhor forma de pagamento.\n\n"
        "Atenciosamente,\nEquipe de Cobrança — Rede Saúde",
    ),
    (
        "whatsapp-acordo",
        "Parcela de acordo em atraso (WhatsApp)",
        "whatsapp",
        "ACORDO",
        "",
        "Olá, {{primeiro_nome}}! Aqui é da Rede Saúde.\n"
        "A parcela {{parcela}} do seu acordo venceu em {{vencimento}} ({{dias}} dias) e está em aberto, "
        "no valor de {{valor}}.\n\n"
        "Podemos ver juntos a melhor forma de regularizar para manter o acordo ativo?",
    ),
    (
        "email-coparticipacao",
        "Coparticipação em aberto (e-mail)",
        "email",
        "CO-PARTICIPACAO",
        "Coparticipação em aberto — {{competencia}}",
        "Olá, {{primeiro_nome}}.\n\n"
        "Consta em aberto a cobrança de coparticipação de {{competencia}}, vencida em {{vencimento}} "
        "({{dias}} dias em atraso), no valor de {{valor}}.\n\n"
        "Se o pagamento já foi feito, envie o comprovante respondendo este e-mail. "
        "Se tiver dúvida sobre os atendimentos, podemos detalhar.\n\n"
        "Atenciosamente,\nEquipe de Cobrança — Rede Saúde",
    ),
    (
        "whatsapp-coparticipacao",
        "Coparticipação em aberto (WhatsApp)",
        "whatsapp",
        "CO-PARTICIPACAO",
        "",
        "Olá, {{primeiro_nome}}! Aqui é da Rede Saúde.\n"
        "Temos uma coparticipação de {{competencia}} em aberto desde {{vencimento}} ({{dias}} dias), "
        "no valor de {{valor}}.\n\n"
        "Se já pagou, envie o comprovante por aqui. Se tiver dúvida, posso detalhar os atendimentos.",
    ),
    (
        "email-geral",
        "Cobrança em aberto (e-mail)",
        "email",
        "",
        "Valor em aberto — {{competencia}}",
        "Olá, {{primeiro_nome}}.\n\n"
        "Identificamos um valor em aberto ({{tipo}}) de {{valor}}, referente a {{competencia}}, "
        "vencido em {{vencimento}} ({{dias}} dias em atraso).\n\n"
        "Se o pagamento já foi feito, envie o comprovante respondendo este e-mail. "
        "Se precisar, podemos verificar juntos.\n\n"
        "Atenciosamente,\nEquipe de Cobrança — Rede Saúde",
    ),
    (
        "whatsapp-geral",
        "Cobrança em aberto (WhatsApp)",
        "whatsapp",
        "",
        "",
        "Olá, {{primeiro_nome}}! Aqui é da Rede Saúde.\n"
        "Identificamos um valor em aberto ({{tipo}}) de {{valor}}, de {{competencia}}, "
        "vencido em {{vencimento}} ({{dias}} dias).\n\n"
        "Se já pagou, pode enviar o comprovante por aqui. Se precisar, verificamos juntos.",
    ),
)


def seed_cobranca_templates(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'cobranca_templates_seed_v1'").fetchone():
        return
    for template_id, name, channel, tipo, subject, body in COBRANCA_DEFAULT_TEMPLATES:
        db.execute(
            "INSERT OR IGNORE INTO cobranca_templates(id, name, channel, tipo, subject, body, active, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (template_id, name, channel, tipo, subject, body, now_iso()),
        )
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('cobranca_templates_seed_v1', ?)", (now_iso(),))
    db.commit()


COBRANCA_TIPO_GROUPS = {
    "PLANO": "mensalidade",
    "PARTICULAR": "mensalidade",
    "DIF MENSALIDADE": "mensalidade",
    "ACORDO": "acordo",
    "ADESAO": "adesao",
    "SINDICATO": "sindicato",
    "COBRANCA": "cobranca",
}
COBRANCA_GROUP_LABELS = {
    "mensalidade": ("Mensalidade", "Mensalidades", "mensalidade", "mensalidades"),
    "acordo": ("Acordo", "Acordos", "parcela do acordo", "parcelas do acordo"),
    "adesao": ("Adesão", "Adesões", "adesão", "adesões"),
    "sindicato": ("Sindicato", "Sindicato", "lançamento do sindicato", "lançamentos do sindicato"),
    "cobranca": ("Cobrança", "Cobranças", "cobrança", "cobranças"),
    "outros": ("Outro valor", "Outros valores", "lançamento", "lançamentos"),
}
COBRANCA_GROUP_ORDER = ("mensalidade", "acordo", "adesao", "sindicato", "cobranca", "outros")
COBRANCA_PHONE_FIXO = "(85) 4141-3734"
COBRANCA_PHONE_WHATSAPP = "(85) 99633-8854"
COBRANCA_DOC_DIGITS_SQL = (
    "replace(replace(replace(replace(documento, '.', ''), '/', ''), '-', ''), ' ', '')"
)


def cobranca_only_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def cobranca_date_iso(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    for pattern, fmt in (("^\\d{2}/\\d{2}/\\d{4}", "%d/%m/%Y"), ("^\\d{4}-\\d{2}-\\d{2}", "%Y-%m-%d")):
        if re.match(pattern, raw):
            try:
                return datetime.strptime(raw[:10], fmt).strftime("%Y-%m-%d")
            except ValueError:
                return ""
    return ""


def cobranca_is_deposit(tipo_pagamento):
    text = unicodedata.normalize("NFKD", str(tipo_pagamento or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return "DEPOSITO" in text.upper()


def cobranca_is_cancelada(situacao):
    text = unicodedata.normalize("NFKD", str(situacao or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).upper()
    return "CANCELAD" in text or "SUSPENSO PARA CANCELAMENTO" in text


def cobranca_money(value):
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    raw = str(value or "").strip().replace("R$", "").replace(" ", "")
    if not raw:
        return 0.0
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return round(float(raw), 2)
    except ValueError:
        return 0.0


def cobranca_clean_list(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    cleaned = []
    for item in value:
        text = str(item or "").strip()
        if text and text not in cleaned:
            cleaned.append(text[:160])
    return cleaned


def cobranca_days_overdue(vencimento_iso):
    iso = cobranca_date_iso(vencimento_iso)
    if not iso:
        return 0
    try:
        due = datetime.strptime(iso, "%Y-%m-%d").date()
    except ValueError:
        return 0
    return max(0, (date.today() - due).days)


def cobranca_case_key(row):
    parts = [
        cobranca_only_digits(row["documento"]) or str(row["cliente"]).lower(),
        str(row["competencia"]).strip().lower(),
        str(row["vencimento"]).strip(),
        str(row["parcela"]).strip(),
        str(row["tipo_parcela"]).strip().upper(),
        f'{cobranca_money(row["valor"]):.2f}',
    ]
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


def cobranca_normalize_row(raw):
    row = raw if isinstance(raw, dict) else {}
    vencimento = cobranca_date_iso(row.get("vencimento"))
    cliente = str(row.get("cliente") or "").strip()[:160]
    cd_associado = str(row.get("cdAssociado") or row.get("cd_associado") or "").strip()[:20]
    if not cd_associado:
        code = re.match(r"^\s*(\d+)\s*-", cliente)
        cd_associado = code.group(1) if code else ""
    return {
        "cliente": cliente,
        "documento": str(row.get("documento") or "").strip()[:40],
        "empresa": str(row.get("empresa") or "").strip()[:160],
        "grupo": str(row.get("grupo") or "").strip()[:160],
        "departamento": str(row.get("departamento") or "").strip()[:160],
        "cd_associado": cd_associado,
        "tipo_parcela": str(row.get("tipoParcela") or row.get("tipo_parcela") or "").strip().upper()[:40],
        "tipo_pagamento": str(row.get("tipoPagamento") or row.get("tipo_pagamento") or "").strip()[:80],
        "nao_cobrar": 1 if cobranca_is_deposit(row.get("tipoPagamento") or row.get("tipo_pagamento")) else 0,
        "cancelada": 1 if cobranca_is_cancelada(row.get("situacao")) else 0,
        "competencia": str(row.get("competencia") or "").strip()[:40],
        "parcela": str(row.get("parcela") or "").strip()[:40],
        "situacao": str(row.get("situacao") or "").strip().upper()[:40],
        "vencimento": vencimento,
        "valor": cobranca_money(row.get("valor")),
        "emails": cobranca_clean_list(row.get("emails")),
        "phones": cobranca_clean_list(row.get("phones")),
    }


def cobranca_case_payload(row):
    emails = cobranca_clean_list(row["emails"])
    phones = cobranca_clean_list(row["phones"])
    tipo = str(row["tipo_parcela"] or "").strip().upper()
    return {
        "id": row["id"],
        "cliente": row["cliente"],
        "documento": row["documento"],
        "empresa": row["empresa"],
        "grupo": row["grupo"],
        "departamento": row["departamento"],
        "cdAssociado": row["cd_associado"],
        "tipoParcela": row["tipo_parcela"],
        "tipoLabel": COBRANCA_TIPO_LABELS.get(tipo, row["tipo_parcela"] or "Cobrança"),
        "tipoPagamento": row["tipo_pagamento"],
        "naoCobrar": bool(row["nao_cobrar"]),
        "cancelada": bool(row["cancelada"]),
        "competencia": row["competencia"],
        "parcela": row["parcela"],
        "situacao": row["situacao"],
        "vencimento": row["vencimento"],
        "diasAtraso": cobranca_days_overdue(row["vencimento"]),
        "valor": round(float(row["valor"] or 0), 2),
        "emails": emails,
        "phones": phones,
        "status": row["status"],
        "statusLabel": COBRANCA_STATUS_LABELS.get(row["status"], row["status"]),
        "origem": row["origem"],
        "firstSeen": row["first_seen"],
        "lastSeen": row["last_seen"],
        "lastContactAt": row["last_contact_at"],
        "nextContact": row["next_contact"],
        "contactCount": int(row["contact_count"] or 0),
        "notes": row["notes"],
        "closedAt": row["closed_at"],
    }


def cobranca_html_escape(value):
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def cobranca_tipo_group(tipo):
    return COBRANCA_TIPO_GROUPS.get(str(tipo or "").strip().upper(), "outros")


def cobranca_clean_client_name(cliente):
    return re.sub(r"^\s*\d+\s*-\s*", "", str(cliente or "")).strip()


def cobranca_email_is_internal(email):
    text = str(email or "").strip().lower()
    return any(hint in text for hint in COBRANCA_INTERNAL_EMAIL_HINTS)


def cobranca_email_is_valid(email):
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", str(email or "").strip()))


def cobranca_parse_cc(payload, to_email="", limit=20):
    """Endereços de cópia informados manualmente (texto ou lista), sem duplicar o destinatário."""
    values = payload.get("cc") if isinstance(payload, dict) else None
    if isinstance(values, str):
        values = re.split(r"[,;\s]+", values)
    elif not isinstance(values, list):
        values = []
    cc = []
    invalid = []
    target = str(to_email or "").strip().lower()
    for value in values:
        email = str(value or "").strip()
        if not email or email.lower() == target:
            continue
        if not cobranca_email_is_valid(email):
            invalid.append(email[:160])
            continue
        if any(existing.lower() == email.lower() for existing in cc):
            continue
        cc.append(email)
        if len(cc) >= limit:
            break
    return cc, invalid


def cobranca_normalize_company_part(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().upper()


def cobranca_company_key_from_values(documento, cliente, case_id="", empresa="", grupo=""):
    """CNPJ + nome fantasia + grupo empresa identificam a empresa na fila.

    O mesmo CNPJ pode ter mais de um nome fantasia/grupo no S4E e, nesse caso,
    são empresas distintas para a cobrança. Sem fantasia nem grupo, o CNPJ
    sozinho continua sendo a chave.
    """
    digits = cobranca_only_digits(documento)
    name = cobranca_normalize_company_part(cobranca_clean_client_name(cliente))
    fantasia = cobranca_normalize_company_part(empresa) or name
    grupo_norm = cobranca_normalize_company_part(grupo)
    if digits:
        base = "doc:" + digits
    else:
        if not name:
            return "id:" + str(case_id or "")
        base = "nome:" + name
    if not fantasia and not grupo_norm:
        return base
    suffix = hashlib.sha1(f"{fantasia}|{grupo_norm}".encode("utf-8")).hexdigest()[:10]
    return f"{base}:{suffix}"


def cobranca_company_key_for_row(row):
    return cobranca_company_key_from_values(
        row["documento"], row["cliente"], row["id"],
        empresa=row["empresa"] if "empresa" in row.keys() else "",
        grupo=row["grupo"] if "grupo" in row.keys() else "",
    )


def cobranca_company_display_name(rows):
    empresas = {}
    for row in rows:
        empresa = re.sub(r"\s+", " ", str(row["empresa"] or "")).strip()
        if empresa:
            empresas[empresa] = empresas.get(empresa, 0) + 1
    if empresas:
        return max(empresas.items(), key=lambda item: (item[1], len(item[0])))[0]
    names = {}
    for row in rows:
        name = re.sub(r"\s+", " ", cobranca_clean_client_name(row["cliente"])).strip()
        if name:
            names[name] = names.get(name, 0) + 1
    if not names:
        for row in rows:
            empresa = str(row["empresa"] or "").strip()
            if empresa:
                return empresa
        return "Empresa sem nome"
    if len(names) == 1:
        return next(iter(names))
    # Cadastros da mesma empresa costumam compartilhar as primeiras palavras
    # ("PARAIBA SERVICOS DNIT", "PARAIBA SERVICOS SESI"...); usa o prefixo
    # comum quando ele cobre a maioria dos títulos.
    total = sum(names.values())
    prefixes = {}
    for name, count in names.items():
        words = name.split()
        if len(words) < 2:
            continue
        prefix = " ".join(words[:2])
        entry = prefixes.get(prefix.upper())
        if entry is None:
            entry = {"label": prefix, "count": 0}
            prefixes[prefix.upper()] = entry
        entry["count"] += count
    if prefixes:
        best = max(prefixes.values(), key=lambda item: item["count"])
        if best["count"] / total >= 0.6:
            return best["label"]
    return max(names.items(), key=lambda item: (item[1], len(item[0])))[0]


def cobranca_company_bucket_payload(bucket, cc_map=None):
    rows = bucket["rows"]
    casos = sorted(
        (cobranca_case_payload(row) for row in rows),
        key=lambda item: (item["vencimento"] or "9999-99-99", item["cliente"]),
    )
    ativos = [item for item in casos if item["status"] in COBRANCA_ACTIVE_STATUSES]
    referencia = ativos or casos
    cancelada = any(item["cancelada"] for item in referencia)
    deposito = bool(referencia) and all(item["naoCobrar"] for item in referencia)
    cobraveis = [item for item in ativos if not item["naoCobrar"] and not item["cancelada"]]

    emails = []
    emails_internos = []
    phones = []
    for item in casos:
        for value in item["emails"]:
            if cobranca_email_is_internal(value):
                if value not in emails_internos:
                    emails_internos.append(value)
                continue
            if value not in emails:
                emails.append(value)
        for value in item["phones"]:
            if value not in phones:
                phones.append(value)

    clientes = []
    seen_clients = {}
    for item in casos:
        key = (item["cliente"], item["cdAssociado"])
        entry = seen_clients.get(key)
        if entry is None:
            entry = {
                "cliente": item["cliente"],
                "cdAssociado": item["cdAssociado"],
                "cases": 0,
                "total": 0.0,
            }
            seen_clients[key] = entry
            clientes.append(entry)
        entry["cases"] += 1
        entry["total"] += item["valor"]
    for entry in clientes:
        entry["total"] = round(entry["total"], 2)
    clientes.sort(key=lambda item: (item["total"], item["cases"]), reverse=True)

    composicao = {}
    for item in cobraveis:
        group = cobranca_tipo_group(item["tipoParcela"])
        entry = composicao.get(group)
        if entry is None:
            entry = {
                "key": group,
                "label": COBRANCA_GROUP_LABELS[group][0],
                "labelPlural": COBRANCA_GROUP_LABELS[group][1],
                "count": 0,
                "total": 0.0,
                "competencias": [],
                "parcelas": [],
            }
            composicao[group] = entry
        entry["count"] += 1
        entry["total"] += item["valor"]
        competencia = str(item["competencia"] or "").strip()
        if competencia and competencia not in entry["competencias"]:
            entry["competencias"].append(competencia)
        parcela = str(item["parcela"] or "").strip()
        if parcela and parcela not in entry["parcelas"]:
            entry["parcelas"].append(parcela)
    composicao_lista = []
    for group in COBRANCA_GROUP_ORDER:
        entry = composicao.get(group)
        if entry:
            entry["total"] = round(entry["total"], 2)
            composicao_lista.append(entry)

    vencimentos = [item["vencimento"] for item in cobraveis if item["vencimento"]]
    vencimento = min(vencimentos) if vencimentos else ""
    limite_30 = (date.today() - timedelta(days=30)).isoformat()
    ultimos_contatos = [item["lastContactAt"] for item in casos if item["lastContactAt"]]
    proximos = sorted(item["nextContact"] for item in casos if item["nextContact"])
    hoje = date.today().isoformat()
    proximo = next((value for value in proximos if value >= hoje), proximos[0] if proximos else "")

    total_ativo = round(sum(item["valor"] for item in ativos), 2)
    total_cobrar = round(sum(item["valor"] for item in cobraveis), 2)
    grupos = []
    for item in casos:
        grupo = str(item["grupo"] or "").strip()
        if grupo and grupo not in grupos:
            grupos.append(grupo)

    cc = []
    for grupo in grupos:
        config = (cc_map or {}).get(grupo.upper())
        if not config:
            continue
        for value in config.get("emails") or []:
            if value in cc or value in emails:
                continue
            cc.append(value)

    if cancelada:
        status_key = "encerrado"
        status_label = "Empresa cancelada"
        motivo = "Empresa cancelada no S4E — não pode ser cobrada."
    elif deposito:
        status_key = "encerrado"
        status_label = "Depósito bancário"
        motivo = "Forma de recebimento por depósito bancário — fora da cobrança automática."
    else:
        status_key = "aberto"
        statuses = {item["status"] for item in cobraveis}
        for candidate in ("promessa", "em_cobranca", "sem_contato", "aberto"):
            if candidate in statuses:
                status_key = candidate
                break
        status_label = COBRANCA_STATUS_LABELS.get(status_key, status_key)
        motivo = ""

    return {
        "key": bucket["key"],
        "nome": cobranca_company_display_name(rows),
        "documento": next((str(item["documento"]) for item in casos if item["documento"]), ""),
        "grupo": grupos[0] if grupos else "",
        "grupos": grupos,
        "clientes": clientes,
        "cadastros": len(clientes),
        "casos": casos,
        "cases": len(ativos),
        "casesCobrar": len(cobraveis),
        "total": total_ativo,
        "totalCobrar": total_cobrar,
        "vencimento": vencimento,
        "diasAtraso": cobranca_days_overdue(vencimento) if vencimento else 0,
        "emAtraso30": sum(1 for item in cobraveis if item["vencimento"] and item["vencimento"] <= limite_30),
        "composicao": composicao_lista,
        "temAcordo": any(entry["key"] == "acordo" for entry in composicao_lista),
        "emails": emails,
        "emailsIgnorados": emails_internos,
        "cc": cc,
        "phones": phones,
        "temEmail": bool(emails),
        "temWhatsapp": bool(phones),
        "cancelada": cancelada,
        "deposito": deposito,
        "bloqueada": cancelada or deposito,
        "podeCobrar": bool(cobraveis),
        "motivo": motivo,
        "status": status_key,
        "statusLabel": status_label,
        "lastContactAt": max(ultimos_contatos) if ultimos_contatos else "",
        "nextContact": proximo,
        "contactCount": sum(int(item["contactCount"] or 0) for item in casos),
        "lastSeen": max((str(item["lastSeen"] or "") for item in casos), default=""),
        "entradas": [],
        "casosCobrar": cobraveis,
    }


def cobranca_group_companies(rows, cc_map=None):
    buckets = {}
    for row in rows:
        key = cobranca_company_key_for_row(row)
        bucket = buckets.get(key)
        if bucket is None:
            bucket = {"key": key, "rows": []}
            buckets[key] = bucket
        bucket["rows"].append(row)
    return [cobranca_company_bucket_payload(bucket, cc_map) for bucket in buckets.values()]


COBRANCA_MESES = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "março": 3, "abril": 4,
    "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9,
    "outubro": 10, "novembro": 11, "dezembro": 12,
}


def cobranca_entry_order(entry):
    competencia = str(entry.get("competencia") or "").strip()
    match = re.match(r"^\s*([A-Za-zÀ-ÿ]+)\s*/\s*(\d{4})", competencia)
    if match:
        month = COBRANCA_MESES.get(match.group(1).lower())
        if month:
            return (int(match.group(2)), month, 0)
    match = re.match(r"^\s*(\d{1,2})\s*/\s*(\d{4})", competencia)
    if match and 1 <= int(match.group(1)) <= 12:
        return (int(match.group(2)), int(match.group(1)), 0)
    vencimento = str(entry.get("vencimento") or "")
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", vencimento)
    if match:
        return (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    return (9999, 99, 99)


def cobranca_company_entries(company):
    entries = []
    mensalidades = {}
    outros = {}
    for item in company["casosCobrar"]:
        group = cobranca_tipo_group(item["tipoParcela"])
        competencia = str(item["competencia"] or "").strip()
        if group == "mensalidade":
            key = competencia.upper() or item["vencimento"] or item["id"]
            entry = mensalidades.get(key)
            if entry is None:
                entry = {
                    "group": group,
                    "titulo": competencia or "Mensalidade",
                    "detalhe": "",
                    "count": 0,
                    "competencia": competencia,
                    "vencimento": item["vencimento"],
                    "valor": 0.0,
                }
                mensalidades[key] = entry
            entry["count"] += 1
            entry["valor"] += item["valor"]
            if item["vencimento"] and (not entry["vencimento"] or item["vencimento"] < entry["vencimento"]):
                entry["vencimento"] = item["vencimento"]
        elif group == "acordo":
            entries.append({
                "group": group,
                "titulo": "Acordo" + (f" · parcela {item['parcela']}" if item["parcela"] else ""),
                "detalhe": "Parcela do acordo",
                "count": 1,
                "competencia": competencia,
                "parcela": item["parcela"],
                "vencimento": item["vencimento"],
                "valor": round(float(item["valor"] or 0), 2),
            })
        else:
            key = (group, competencia.upper(), item["vencimento"])
            entry = outros.get(key)
            if entry is None:
                titulo = item["tipoLabel"] or COBRANCA_GROUP_LABELS[group][0]
                if competencia:
                    titulo += f" · {competencia}"
                entry = {
                    "group": group,
                    "titulo": titulo,
                    "detalhe": "",
                    "count": 0,
                    "competencia": competencia,
                    "vencimento": item["vencimento"],
                    "valor": 0.0,
                }
                outros[key] = entry
            entry["count"] += 1
            entry["valor"] += item["valor"]
    entries.extend(mensalidades.values())
    entries.extend(outros.values())
    for entry in entries:
        entry["valor"] = round(entry["valor"], 2)
        if entry["group"] == "mensalidade":
            entry["detalhe"] = (
                f"{entry['count']} mensalidades" if entry["count"] > 1 else "Mensalidade"
            )
        elif entry["group"] != "acordo":
            if entry["count"] > 1:
                entry["detalhe"] = f"{entry['count']} lançamentos"
    entries.sort(key=lambda item: (cobranca_entry_order(item), item["titulo"]))
    return entries


def cobranca_company_composicao_texto(company):
    partes = []
    for entry in company["composicao"]:
        count = entry["count"]
        if entry["key"] == "mensalidade":
            texto = f"{count} mensalidade{'s' if count > 1 else ''}"
            competencias = entry["competencias"]
            if len(competencias) > 1:
                texto += f" ({competencias[0]} a {competencias[-1]})"
            elif competencias:
                texto += f" ({competencias[0]})"
        elif entry["key"] == "acordo":
            texto = f"{count} parcela{'s' if count > 1 else ''} do acordo"
            if entry["parcelas"]:
                texto += f" ({', '.join(entry['parcelas'][:4])}{'…' if len(entry['parcelas']) > 4 else ''})"
        else:
            texto = f"{count} {entry['label'].lower() if count == 1 else entry['labelPlural'].lower()}"
        partes.append(texto)
    return ", ".join(partes)


def cobranca_company_scenario(company):
    grupos = {entry["key"]: entry for entry in company["composicao"]}
    mensalidade = grupos.get("mensalidade")
    acordo = grupos.get("acordo")
    outros = [
        entry for key, entry in grupos.items()
        if key not in ("mensalidade", "acordo")
    ]
    if mensalidade and acordo:
        abertura = (
            "Conforme verificação em nosso sistema, identificamos que os vencimentos abaixo "
            "encontram-se em aberto, incluindo mensalidades e parcelas do acordo:"
        )
        assunto = "Mensalidades e acordo em aberto"
    elif mensalidade:
        count = mensalidade["count"]
        if count > 1:
            abertura = (
                f"Conforme verificação em nosso sistema, identificamos que as {count} mensalidades "
                "abaixo encontram-se em aberto:"
            )
            assunto = f"{count} mensalidades em aberto"
        else:
            abertura = (
                "Conforme verificação em nosso sistema, identificamos que a mensalidade abaixo "
                "encontra-se em aberto:"
            )
            assunto = "Mensalidade em aberto"
    elif acordo:
        count = acordo["count"]
        if count > 1:
            abertura = (
                f"Conforme verificação em nosso sistema, identificamos que as {count} parcelas "
                "do acordo abaixo encontram-se em aberto:"
            )
            assunto = f"{count} parcelas do acordo em aberto"
        else:
            abertura = (
                "Conforme verificação em nosso sistema, identificamos que a parcela do acordo "
                "abaixo encontra-se em aberto:"
            )
            assunto = "Parcela do acordo em aberto"
    else:
        abertura = (
            "Conforme verificação em nosso sistema, identificamos que os vencimentos abaixo "
            "encontram-se em aberto:"
        )
        assunto = "Valores em aberto"
    if outros:
        labels = ", ".join(
            f"{entry['count']} {entry['label'].lower() if entry['count'] == 1 else entry['labelPlural'].lower()}"
            for entry in outros
        )
        abertura = abertura.rstrip(":") + f". Constam também {labels} em aberto:"
        grupos = ["mensalidades"] if mensalidade else []
        if acordo:
            grupos.append("acordo")
        grupos.extend(entry["labelPlural"].lower() for entry in outros)
        if grupos:
            assunto = ", ".join(grupos[:-1]) + (f" e {grupos[-1]}" if len(grupos) > 1 else grupos[-1])
            assunto = assunto[:1].upper() + assunto[1:] + " em aberto"
    return assunto, abertura


def cobranca_company_text(company, abertura, entries):
    linhas = []
    for entry in entries:
        partes = [str(entry["titulo"]).strip()]
        if entry["detalhe"]:
            partes.append(entry["detalhe"])
        if entry["vencimento"]:
            partes.append("venc. " + cobranca_date_br(entry["vencimento"]))
        partes.append(cobranca_brl(entry["valor"]))
        linhas.append("• " + " — ".join(partes))
    resumo = cobranca_company_composicao_texto(company)
    cadastros = ""
    if company["cadastros"] > 1:
        cadastros = (
            f"\n\nValores consolidados de {company['cadastros']} cadastros desta empresa "
            f"(CNPJ {company['documento']})."
        )
    return (
        f"Prezada, empresa {company['nome']}.\n\n"
        f"{abertura}\n\n"
        + "\n".join(linhas)
        + f"\n\nTotal em aberto: {cobranca_brl(company['totalCobrar'])}"
        + (f"\nComposição: {resumo}." if resumo else "")
        + f"{cadastros}\n\n"
        "Para fins informativos, o valor apresentado nesta cobrança corresponde ao valor nominal "
        "dos títulos. O valor final do boleto pode apresentar diferença em razão de impostos, "
        "juros ou multas, conforme aplicável.\n\n"
        "Caso o pagamento já tenha sido realizado, solicitamos desconsiderar este e-mail e, "
        "se possível, enviar o comprovante para conferência. Se o pagamento foi efetuado via "
        "depósito bancário, solicitamos o envio do comprovante.\n\n"
        "Se ainda não houve o pagamento, solicitamos a regularização o quanto antes para evitar "
        "o bloqueio automático dos atendimentos.\n\n"
        "Atenciosamente,\n"
        "Equipe Faturamento\n"
        f"Fixo: {COBRANCA_PHONE_FIXO}\n"
        f"WhatsApp: {COBRANCA_PHONE_WHATSAPP}"
    )


def cobranca_company_html(company, subject, abertura, entries):
    pills = "".join(
        '<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 11px;border-radius:999px;'
        'background:#eef4f4;color:#2a555d;font-size:11.5px;font-weight:600;">'
        f"{entry['count']} {entry['label'].lower() if entry['count'] == 1 else entry['labelPlural'].lower()}"
        "</span>"
        for entry in company["composicao"]
    )
    rows = []
    for index, entry in enumerate(entries):
        background = "#f6faf9" if index % 2 == 0 else "#ffffff"
        detalhe = entry["detalhe"] if entry["detalhe"] and entry["detalhe"] != "—" else ""
        vencimento = cobranca_date_br(entry["vencimento"]) if entry["vencimento"] else ""
        meta = " · ".join(part for part in (detalhe, f"Venc. {vencimento}" if vencimento else "") if part)
        rows.append(
            f'<div style="padding:12px 14px;border-top:1px solid #e6efed;background:{background};">'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">'
            "<tr>"
            '<td style="padding:0 10px 0 0;vertical-align:top;font-size:13.5px;line-height:1.45;'
            'color:#17323a;font-weight:600;word-break:break-word;">'
            f'{cobranca_html_escape(entry["titulo"])}'
            + (
                f'<div style="margin-top:3px;font-size:12px;line-height:1.45;color:#5b747c;font-weight:400;">'
                f"{cobranca_html_escape(meta)}</div>"
                if meta else ""
            )
            + "</td>"
            '<td align="right" style="vertical-align:top;white-space:nowrap;font-size:13.5px;'
            'color:#17323a;font-weight:700;">'
            f'{cobranca_html_escape(cobranca_brl(entry["valor"]))}</td>'
            "</tr></table></div>"
        )
    resumo = cobranca_company_composicao_texto(company)
    cadastros = ""
    if company["cadastros"] > 1:
        cadastros = (
            '<p style="margin:12px 0 0;font-size:12px;line-height:1.55;color:#5b747c;">'
            f"Valores consolidados de <strong>{company['cadastros']} cadastros</strong> desta empresa "
            f"(CNPJ {cobranca_html_escape(company['documento'])}).</p>"
        )
    return (
        '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="x-apple-disable-message-reformatting">'
        f"<title>{cobranca_html_escape(subject)}</title>"
        "<style>"
        "body{margin:0;padding:0;}"
        "table{border-collapse:collapse;}"
        "a{text-decoration:none;}"
        "@media only screen and (max-width:600px){"
        ".cobranca-card{border-radius:14px!important;}"
        ".cobranca-head{padding:20px 16px!important;}"
        ".cobranca-head-title{font-size:19px!important;line-height:1.3!important;}"
        ".cobranca-body{padding:18px 16px 22px!important;}"
        ".cobranca-total{padding:14px 16px!important;}"
        ".cobranca-total-value{font-size:21px!important;}"
        ".cobranca-note{padding:12px 16px!important;}"
        "}"
        "</style></head>"
        '<body style="margin:0;padding:0;background:#eef4f4;">'
        '<div style="background:#eef4f4;padding:18px 10px;font-family:\'Segoe UI\',Arial,sans-serif;color:#17323a;">'
        '<div class="cobranca-card" style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;'
        'border-radius:18px;overflow:hidden;border:1px solid #d9e6e4;box-shadow:0 12px 32px rgba(11,111,122,0.10);">'
        '<div class="cobranca-head" style="background:#0b6f7a;'
        'background-image:linear-gradient(135deg,#0b6f7a 0%,#155a63 55%,#3b1d4e 100%);'
        'padding:22px 20px;color:#ffffff;">'
        '<div style="font-size:10.5px;letter-spacing:2.2px;text-transform:uppercase;opacity:.82;">Rede Saúde · Faturamento</div>'
        f'<div class="cobranca-head-title" style="margin-top:8px;font-size:22px;font-weight:700;line-height:1.28;word-break:break-word;">{cobranca_html_escape(subject)}</div>'
        f'<div style="margin-top:6px;font-size:13.5px;opacity:.9;word-break:break-word;">{cobranca_html_escape(company["nome"])}</div>'
        '</div>'
        '<div class="cobranca-body" style="padding:22px 20px 26px;">'
        f'<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">Prezada, empresa <strong>{cobranca_html_escape(company["nome"])}</strong>.</p>'
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">{cobranca_html_escape(abertura)}</p>'
        f'<div style="margin:0 0 16px;line-height:1.8;">{pills}</div>'
        '<div class="cobranca-titles" style="margin:0 0 18px;border:1px solid #dfeae8;border-radius:14px;overflow:hidden;">'
        '<div style="padding:9px 14px;background:#0b6f7a;color:#ffffff;font-size:10px;'
        'letter-spacing:.9px;text-transform:uppercase;">Títulos em aberto</div>'
        + "".join(rows)
        + "</div>"
        '<div class="cobranca-total" style="padding:16px 18px;border-radius:14px;background:#eaf8f3;'
        'border:1px solid #bfe3d9;color:#125a4f;">'
        '<div style="font-size:11.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#125a4f;">Total em aberto</div>'
        f'<div class="cobranca-total-value" style="margin-top:2px;font-size:24px;font-weight:700;line-height:1.25;color:#0b6f7a;word-break:break-word;">{cobranca_html_escape(cobranca_brl(company["totalCobrar"]))}</div>'
        f'<div style="margin-top:3px;font-size:12px;line-height:1.5;color:#125a4f;">{company["casesCobrar"]} título(s)'
        + (f" · {cobranca_html_escape(resumo)}" if resumo else "")
        + "</div></div>"
        + cadastros
        + '<div style="margin:18px 0 0;padding:12px 16px;border-radius:12px;background:#f4f7fb;'
        'border:1px solid #d8e2ef;color:#4b6175;font-size:12px;line-height:1.55;">'
        "<strong>Informação:</strong> o valor apresentado nesta cobrança corresponde ao valor "
        "nominal dos títulos. O valor final do boleto pode apresentar diferença em razão de "
        "impostos, juros ou multas, conforme aplicável.</div>"
        + '<div style="margin:18px 0 0;padding:14px 16px;border-radius:12px;background:#fff7e8;'
        'border:1px solid #f2dfb5;color:#71551e;font-size:13px;line-height:1.55;">'
        "<strong>Caso o pagamento já tenha sido realizado</strong>, solicitamos desconsiderar este e-mail e, "
        "se possível, enviar o comprovante para conferência. Se o pagamento foi efetuado via "
        "<strong>depósito bancário</strong>, solicitamos o envio do comprovante.</div>"
        '<p style="margin:18px 0 0;font-size:14px;line-height:1.6;">Se ainda não houve o pagamento, '
        "solicitamos a regularização o quanto antes para evitar o <strong>bloqueio automático dos atendimentos</strong>.</p>"
        '<div style="margin:22px 0 0;padding-top:16px;border-top:1px solid #e3ecea;font-size:13px;line-height:1.6;">'
        '<strong style="font-size:14px;">Atenciosamente,<br>Equipe Faturamento</strong>'
        f'<div style="margin-top:10px;color:#4d656c;">Fixo: <a href="tel:+558541413734" style="color:#0b6f7a;font-weight:600;">{COBRANCA_PHONE_FIXO}</a></div>'
        f'<div style="margin-top:2px;color:#4d656c;">WhatsApp: <a href="https://wa.me/5585996338854" style="color:#0b6f7a;font-weight:600;">{COBRANCA_PHONE_WHATSAPP}</a></div>'
        "</div></div>"
        '<div class="cobranca-note" style="padding:14px 20px;background:#f4f9f8;border-top:1px solid #e3ecea;'
        'font-size:11px;line-height:1.5;color:#6b8188;">'
        "Mensagem automática do setor de faturamento da Rede Saúde. Em caso de dúvida, responda este e-mail."
        "</div></div></div></body></html>"
    )

def cobranca_company_message(company):
    assunto, abertura = cobranca_company_scenario(company)
    entries = company.get("entradas") or cobranca_company_entries(company)
    company["entradas"] = entries
    subject = f"{assunto} — {company['nome']}"[:200]
    return {
        "subject": subject,
        "text": cobranca_company_text(company, abertura, entries),
        "html": cobranca_company_html(company, assunto, abertura, entries),
        "abertura": abertura,
        "entradas": entries,
        "resumo": cobranca_company_composicao_texto(company),
        "total": company["totalCobrar"],
        "quantidade": company["casesCobrar"],
    }


def cobranca_company_public(company, full=False):
    data = {key: value for key, value in company.items() if key not in ("casos", "casosCobrar", "entradas")}
    data["emails"] = company["emails"][:3]
    data["phones"] = company["phones"][:3]
    data["composicao"] = [
        {
            "key": entry["key"],
            "label": entry["label"],
            "labelPlural": entry["labelPlural"],
            "count": entry["count"],
            "total": entry["total"],
        }
        for entry in company["composicao"]
    ]
    if full:
        data["casos"] = company["casos"]
        data["casosCobrar"] = company["casosCobrar"]
        data["mensagem"] = cobranca_company_message(company)
    return data


def cobranca_company_counts(companies):
    counts = {
        "empresas": len(companies),
        "empresasCobrar": 0,
        "empresasDeposito": 0,
        "empresasCanceladas": 0,
        "empresasAcordo": 0,
        "empresasSemEmail": 0,
        "empresasSemWhatsapp": 0,
        "empresasCobradasHoje": 0,
        "titulosCobrar": 0,
        "valorCobrar": 0.0,
    }
    hoje = date.today().isoformat()
    for company in companies:
        if company["cancelada"]:
            counts["empresasCanceladas"] += 1
        elif company["deposito"]:
            counts["empresasDeposito"] += 1
        else:
            counts["empresasCobrar"] += 1
            if not company["temEmail"]:
                counts["empresasSemEmail"] += 1
            if not company["temWhatsapp"]:
                counts["empresasSemWhatsapp"] += 1
            counts["titulosCobrar"] += company["casesCobrar"]
            counts["valorCobrar"] += company["totalCobrar"]
        if company["temAcordo"]:
            counts["empresasAcordo"] += 1
        if str(company["lastContactAt"] or "")[:10] == hoje:
            counts["empresasCobradasHoje"] += 1
    counts["valorCobrar"] = round(counts["valorCobrar"], 2)
    return counts


def cobranca_sort_companies(companies, sort):
    if sort == "venc_desc":
        return sorted(companies, key=lambda item: (item["vencimento"] or "0000-00-00", item["total"]), reverse=True)
    if sort == "valor_desc":
        return sorted(companies, key=lambda item: (item["total"], item["vencimento"] or "9999-99-99"), reverse=True)
    if sort == "contato_asc":
        return sorted(companies, key=lambda item: (item["lastContactAt"] or "0000", item["vencimento"] or "9999-99-99"))
    if sort == "atualizado":
        return sorted(companies, key=lambda item: (item["lastSeen"] or "", item["vencimento"] or "9999-99-99"), reverse=True)
    if sort == "nome":
        return sorted(companies, key=lambda item: item["nome"].lower())
    return sorted(companies, key=lambda item: (item["vencimento"] or "9999-99-99", -item["total"]))


def cobranca_key_digits(key):
    match = re.match(r"^doc:(\d+)", str(key or ""))
    return match.group(1) if match else ""


def cobranca_company_detail(db, key):
    key = str(key or "").strip()
    if not key:
        return None
    cc_map = cobranca_group_cc_map(db)
    placeholders = ",".join("?" for _ in COBRANCA_ACTIVE_STATUSES)
    digits = cobranca_key_digits(key)
    if digits:
        rows = db.execute(
            f"SELECT * FROM cobranca_cases WHERE {COBRANCA_DOC_DIGITS_SQL} = ? "
            f"AND status IN ({placeholders}) ORDER BY vencimento ASC",
            (digits, *COBRANCA_ACTIVE_STATUSES),
        ).fetchall()
        rows = [row for row in rows if cobranca_company_key_for_row(row) == key]
    else:
        rows = db.execute(
            f"SELECT * FROM cobranca_cases WHERE status IN ({placeholders}) ORDER BY vencimento ASC",
            COBRANCA_ACTIVE_STATUSES,
        ).fetchall()
        rows = [row for row in rows if cobranca_company_key_for_row(row) == key]
    for company in cobranca_group_companies(rows, cc_map):
        if company["key"] == key:
            return company
    # Filtros de "baixados"/"encerrados" também abrem o histórico da empresa.
    if digits:
        rows = db.execute(
            f"SELECT * FROM cobranca_cases WHERE {COBRANCA_DOC_DIGITS_SQL} = ? ORDER BY vencimento ASC",
            (digits,),
        ).fetchall()
        rows = [row for row in rows if cobranca_company_key_for_row(row) == key]
    else:
        rows = db.execute("SELECT * FROM cobranca_cases ORDER BY vencimento ASC").fetchall()
        rows = [row for row in rows if cobranca_company_key_for_row(row) == key]
    for company in cobranca_group_companies(rows, cc_map):
        if company["key"] == key:
            return company
    return None


def cobranca_xlsx_sheet_xml(headers, rows, kinds):
    def row_xml(row_index, values):
        cells = []
        for col_index, kind in enumerate(kinds):
            reference = f"{finance_column_letter(col_index)}{row_index}"
            value = values[col_index] if col_index < len(values) else ""
            if kind == "money":
                cells.append(finance_cell_xml(reference, round(float(value or 0), 2), 1))
            elif kind == "date":
                serial = finance_date_serial(value)
                cells.append(finance_cell_xml(reference, serial, 2) if serial is not None else "")
            elif kind == "int":
                cells.append(finance_cell_xml(reference, int(value or 0)))
            else:
                cells.append(finance_cell_xml(reference, value))
        return f'<row r="{row_index}">' + "".join(cells) + "</row>"

    rows_xml = [
        '<row r="1">' + "".join(
            finance_cell_xml(f"{finance_column_letter(index)}1", header)
            for index, header in enumerate(headers)
        ) + "</row>"
    ]
    for index, values in enumerate(rows, start=2):
        rows_xml.append(row_xml(index, list(values)))
    last_reference = f"{finance_column_letter(max(0, len(headers) - 1))}{len(rows) + 1}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{XLSX_NS[1:-1]}">'
        f'<dimension ref="A1:{last_reference}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        "</sheetView></sheetViews>"
        "<sheetData>" + "".join(rows_xml) + "</sheetData></worksheet>"
    )


def cobranca_build_xlsx(companies):
    empresas_headers = (
        "Empresa", "CPF/CNPJ", "Cadastros", "Códigos dos cadastros", "Títulos a cobrar",
        "Mensalidades", "Parcelas de acordo", "Outros títulos", "Vencimento mais antigo",
        "Dias em atraso", "Valor a cobrar", "Situação", "Cobrar?", "E-mail", "E-mails em cópia",
        "E-mails internos ignorados", "WhatsApp", "Último contato", "Próximo contato", "Grupo",
    )
    empresas_kinds = (
        "text", "text", "int", "text", "int", "int", "int", "int", "date", "int", "money",
    ) + ("text",) * 9
    titulos_headers = (
        "Empresa", "CPF/CNPJ", "Cadastro", "Tipo", "Competência", "Parcela",
        "Situação no S4E", "Vencimento", "Dias em atraso", "Valor", "Status no portal",
        "Cobrar?", "E-mail", "WhatsApp",
    )
    titulos_kinds = (
        "text", "text", "text", "text", "text", "text", "text", "date", "int", "money",
        "text", "text", "text", "text",
    )
    empresas_rows = []
    titulos_rows = []
    for company in companies:
        counts = {entry["key"]: entry["count"] for entry in company["composicao"]}
        outros = sum(
            entry["count"] for entry in company["composicao"]
            if entry["key"] not in ("mensalidade", "acordo")
        )
        empresas_rows.append([
            company["nome"],
            company["documento"],
            company["cadastros"],
            "; ".join(item["cliente"] for item in company["clientes"]),
            company["casesCobrar"],
            counts.get("mensalidade", 0),
            counts.get("acordo", 0),
            outros,
            company["vencimento"],
            company["diasAtraso"],
            company["totalCobrar"],
            company["statusLabel"],
            "Não" if company["bloqueada"] else "Sim",
            "; ".join(company["emails"]),
            "; ".join(company.get("cc") or []),
            "; ".join(company.get("emailsIgnorados") or []),
            "; ".join(company["phones"]),
            company["lastContactAt"] or "",
            company["nextContact"] or "",
            company["grupo"],
        ])
        for item in company["casos"]:
            titulos_rows.append([
                company["nome"], company["documento"], item["cliente"], item["tipoLabel"],
                item["competencia"], item["parcela"], item["situacao"], item["vencimento"],
                item["diasAtraso"], item["valor"], item["statusLabel"],
                "Não" if (item["naoCobrar"] or item["cancelada"]) else "Sim",
                "; ".join(item["emails"]), "; ".join(item["phones"]),
            ])

    sheet_xmls = [
        cobranca_xlsx_sheet_xml(empresas_headers, empresas_rows, empresas_kinds),
        cobranca_xlsx_sheet_xml(titulos_headers, titulos_rows, titulos_kinds),
    ]
    sheet_names = ("Empresas", "T\u00edtulos")
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{XLSX_NS[1:-1]}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        "<sheets>"
        f'<sheet name="{sheet_names[0]}" sheetId="1" r:id="rId1"/>'
        f'<sheet name="{sheet_names[1]}" sheetId="2" r:id="rId2"/>'
        "</sheets></workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{XLSX_NS[1:-1]}">'
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", root_rels)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        package.writestr("xl/styles.xml", styles_xml)
        for index, sheet_xml in enumerate(sheet_xmls, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", sheet_xml)
    return buffer.getvalue()


def cobranca_template_payload(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "channel": row["channel"],
        "tipo": row["tipo"] or "",
        "subject": row["subject"] or "",
        "body": row["body"] or "",
        "active": bool(row["active"]),
    }


def cobranca_history_payload(row):
    return {
        "id": row["id"],
        "caseId": row["case_id"],
        "at": row["at"],
        "channel": row["channel"],
        "templateName": row["template_name"],
        "userName": row["user_name"],
        "result": row["result"],
        "resultLabel": COBRANCA_RESULT_LABELS.get(row["result"], row["result"] or "—"),
        "notes": row["notes"],
        "nextContact": row["next_contact"],
    }


def cobranca_history_group(items):
    """Junta registros do mesmo envio (um por título) em uma linha só."""
    groups = {}
    order = []
    for item in items:
        at = str(item.get("at") or "")
        key = (
            at[:16], item.get("channel"), item.get("result"),
            item.get("userName") or "", item.get("notes") or "", item.get("nextContact") or "",
        )
        group = groups.get(key)
        if group is None:
            group = dict(item)
            group["caseIds"] = []
            group["titles"] = []
            groups[key] = group
            order.append(key)
        case_id = item.get("caseId")
        if case_id and case_id not in group["caseIds"]:
            group["caseIds"].append(case_id)
        titulo = str(item.get("titulo") or "").strip()
        if titulo and titulo not in group["titles"]:
            group["titles"].append(titulo)
    result = []
    for key in order:
        group = groups[key]
        group.pop("titulo", None)
        group["caseCount"] = len(group["caseIds"])
        result.append(group)
    return result


COBRANCA_SEND_KIND_LABELS = {"lote": "Cobrança em lote", "empresa": "Envio da empresa", "teste": "Teste da conta"}


def cobranca_send_log(db, *, kind, company, email, cc, cases, value, channel, status,
                      provider_ref="", error="", user=None):
    """Guarda um envio (ou tentativa) para auditoria — o histórico por título não serve para isso."""
    send_id = uuid.uuid4().hex
    company = company or {}
    user_id = ""
    user_name = ""
    if user is not None:
        try:
            user_id = str(user["id"] or "")
            user_name = str(user["display_name"] or user["username"] or "")
        except (TypeError, KeyError, IndexError):
            user_id = str(getattr(user, "id", "") or "")
            user_name = str(getattr(user, "display_name", "") or getattr(user, "username", "") or "")
    db.execute(
        "INSERT INTO cobranca_sends(id, at, kind, company_key, company_name, documento, email, cc, "
        "cases, value, channel, status, provider_ref, error, user_id, user_name) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            send_id,
            now_iso(),
            kind,
            str(company.get("key") or ""),
            str(company.get("nome") or ""),
            str(company.get("documento") or ""),
            str(email or ""),
            json.dumps([value2 for value2 in (cc or []) if value2], ensure_ascii=False),
            int(cases or 0),
            round(float(value or 0), 2),
            channel,
            status,
            str(provider_ref or ""),
            str(error or "")[:300],
            user_id,
            user_name,
        ),
    )
    return send_id


def cobranca_send_payload(row):
    try:
        cc = json.loads(row["cc"] or "[]")
    except (TypeError, ValueError):
        cc = []
    return {
        "id": row["id"],
        "at": row["at"],
        "kind": row["kind"],
        "kindLabel": COBRANCA_SEND_KIND_LABELS.get(row["kind"], row["kind"] or "—"),
        "companyKey": row["company_key"],
        "company": row["company_name"],
        "documento": row["documento"],
        "email": row["email"],
        "cc": [value for value in cc if isinstance(value, str)],
        "cases": int(row["cases"] or 0),
        "value": float(row["value"] or 0),
        "channel": row["channel"],
        "imported": row["channel"] == "historico",
        "status": row["status"],
        "providerRef": row["provider_ref"],
        "error": row["error"],
        "userName": row["user_name"],
    }


def cobranca_sends_backfill(db):
    """Traz para o registro os envios que já estavam no histórico de contatos.

    O histórico guarda uma linha por título; aqui elas voltam a ser um envio só,
    com destinatário e cópias tirados da anotação. Sem referência do provedor,
    porque na época ela não era guardada.
    """
    if db.execute("SELECT 1 FROM meta WHERE key = 'cobranca_sends_backfill_v1'").fetchone():
        return 0
    rows = db.execute(
        "SELECT h.id, h.case_id, h.at, h.channel, h.result, h.user_id, h.user_name, h.notes, "
        "c.cliente, c.documento, c.empresa, c.grupo, c.valor "
        "FROM cobranca_history h LEFT JOIN cobranca_cases c ON c.id = h.case_id "
        "WHERE h.channel = 'email' AND h.result = 'enviado' "
        "AND h.notes LIKE '%enviada para %' ORDER BY h.at ASC"
    ).fetchall()
    groups = {}
    order = []
    for row in rows:
        company_key = (
            cobranca_company_key_from_values(
                row["documento"], row["cliente"], row["case_id"],
                empresa=row["empresa"] or "", grupo=row["grupo"] or "",
            )
            if row["cliente"] is not None else ""
        )
        key = (company_key, row["at"][:16], row["notes"], row["user_name"])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)
    inserted = 0
    for key in order:
        items = groups[key]
        notes = str(items[0]["notes"] or "").strip()
        match = re.search(r"(?i)enviada para (.+?)\.(?: Em c[óo]pia: (.+?)\.)?$", notes)
        if not match:
            continue
        email = match.group(1).strip()
        cc = [part.strip() for part in (match.group(2) or "").split(",") if part.strip()]
        casos = {}
        for item in items:
            casos[item["case_id"]] = float(item["valor"] or 0)
        first = items[0]
        company_key = key[0]
        send_id = "hist-" + hashlib.sha1(
            f"{company_key}|{first['at'][:19]}|{notes}|{first['user_name']}".encode("utf-8")
        ).hexdigest()[:24]
        cursor = db.execute(
            "INSERT OR IGNORE INTO cobranca_sends(id, at, kind, company_key, company_name, documento, "
            "email, cc, cases, value, channel, status, provider_ref, error, user_id, user_name) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'historico', 'enviado', '', '', ?, ?)",
            (
                send_id,
                first["at"],
                "lote" if "em lote" in notes.lower() else "empresa",
                company_key,
                str(first["cliente"] or ""),
                str(first["documento"] or ""),
                email,
                json.dumps(cc, ensure_ascii=False),
                len(casos),
                round(sum(casos.values()), 2),
                str(first["user_id"] or ""),
                str(first["user_name"] or ""),
            ),
        )
        inserted += cursor.rowcount
    db.execute(
        "INSERT INTO meta(key, value) VALUES ('cobranca_sends_backfill_v1', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (now_iso(),),
    )
    return inserted


def cobranca_filters_from_query(query):
    where = ["1=1"]
    params = []
    status = (query.get("status") or ["ativos"])[0].strip()
    if status == "ativos":
        where.append(f"status IN ({','.join('?' for _ in COBRANCA_ACTIVE_STATUSES)})")
        params.extend(COBRANCA_ACTIVE_STATUSES)
    elif status and status not in ("todos", "todas"):
        where.append("status = ?")
        params.append(status)
    search = (query.get("search") or [""])[0].strip()
    if search:
        like = f"%{search}%"
        digits = cobranca_only_digits(search)
        clauses = ["cliente LIKE ?", "empresa LIKE ?", "grupo LIKE ?", "departamento LIKE ?", "competencia LIKE ?", "parcela LIKE ?", "emails LIKE ?", "phones LIKE ?"]
        params.extend([like] * 8)
        if digits:
            clauses.append(
                "replace(replace(replace(replace(documento, '.', ''), '-', ''), '/', ''), ' ', '') LIKE ?"
            )
            params.append(f"%{digits}%")
        where.append(f"({' OR '.join(clauses)})")
    grupo = (query.get("grupo") or [""])[0].strip()
    if grupo:
        where.append("grupo = ?")
        params.append(grupo)
    tipo = (query.get("tipo") or [""])[0].strip().upper()
    if tipo:
        where.append("tipo_parcela = ?")
        params.append(tipo)
    contato = (query.get("contato") or [""])[0].strip().lower()
    if contato == "com_email":
        where.append("emails != '[]'")
    elif contato == "sem_email":
        where.append("emails = '[]'")
    elif contato == "com_whatsapp":
        where.append("phones != '[]'")
    elif contato == "sem_whatsapp":
        where.append("phones = '[]'")
    deposito = (query.get("deposito") or [""])[0].strip().lower()
    if deposito == "cobrar":
        where.append("nao_cobrar = 0 AND cancelada = 0")
    elif deposito == "deposito":
        where.append("nao_cobrar = 1")
    elif deposito == "cancelada":
        where.append("cancelada = 1")
    date_from = cobranca_date_iso((query.get("from") or [""])[0])
    if date_from:
        where.append("vencimento >= ?")
        params.append(date_from)
    date_to = cobranca_date_iso((query.get("to") or [""])[0])
    if date_to:
        where.append("vencimento <= ?")
        params.append(date_to)
    return " AND ".join(where), params


def cobranca_company_search_filter(db, where, params, query):
    """Busca por empresa: ao achar um cadastro, traz todos os títulos da mesma empresa."""
    search = (query.get("search") or [""])[0].strip()
    if not search:
        return where, params
    rows = db.execute(f"SELECT * FROM cobranca_cases WHERE {where}", params).fetchall()
    keys = {cobranca_company_key_for_row(row) for row in rows}
    if not keys:
        return where, params
    base_query = {key: value for key, value in query.items() if key != "search"}
    base_where, base_params = cobranca_filters_from_query(base_query)
    candidates = db.execute(
        f"SELECT id, documento, cliente, empresa, grupo FROM cobranca_cases WHERE {base_where}",
        base_params,
    ).fetchall()
    ids = [row["id"] for row in candidates if cobranca_company_key_for_row(row) in keys]
    if not ids:
        return where, params
    return f"({base_where}) AND id IN ({','.join('?' for _ in ids)})", (*base_params, *ids)


def cobranca_facet_scope(db, query, drop=""):
    """Filtros ativos sem a dimensão da própria faceta (tipo, grupo ou status)."""
    sub = {key: value for key, value in query.items() if key != drop}
    if drop == "status":
        sub["status"] = ["todos"]
    where, params = cobranca_filters_from_query(sub)
    where, params = cobranca_company_search_filter(db, where, params, sub)
    return where, params


def cobranca_facet_universe(db, query, column, extra=""):
    """Valores que sempre aparecem na lista, mesmo com contagem zero."""
    status_query = {key: value for key, value in query.items() if key == "status"}
    where, params = cobranca_filters_from_query(status_query)
    rows = db.execute(
        f"SELECT DISTINCT {column} AS value FROM cobranca_cases WHERE {where}{extra}",
        params,
    ).fetchall()
    return [row["value"] for row in rows if row["value"]]


def cobranca_facet_payload(db, query):
    where, params = cobranca_facet_scope(db, query, "tipo")
    rows = db.execute(
        f"SELECT tipo_parcela AS tipo, COUNT(*) AS total FROM cobranca_cases "
        f"WHERE {where} GROUP BY tipo_parcela",
        params,
    ).fetchall()
    tipo_counts = {(row["tipo"] or ""): row["total"] for row in rows}
    tipo_values = cobranca_facet_universe(db, query, "tipo_parcela")
    selected_tipo = (query.get("tipo") or [""])[0].strip().upper()
    if selected_tipo and selected_tipo not in tipo_values:
        tipo_values.append(selected_tipo)
    tipos = [
        {
            "value": value,
            "label": COBRANCA_TIPO_LABELS.get(str(value).upper(), value or "Outros"),
            "total": tipo_counts.get(value, 0),
        }
        for value in tipo_values
    ]
    tipos.sort(key=lambda item: (-item["total"], item["label"].lower()))

    where, params = cobranca_facet_scope(db, query, "grupo")
    rows = db.execute(
        f"SELECT grupo, COUNT(*) AS total FROM cobranca_cases "
        f"WHERE {where} AND trim(grupo) != '' GROUP BY grupo ORDER BY grupo COLLATE NOCASE",
        params,
    ).fetchall()
    group_counts = {row["grupo"]: row["total"] for row in rows}
    group_values = sorted(
        cobranca_facet_universe(db, query, "grupo", " AND trim(grupo) != ''"),
        key=str.lower,
    )
    selected_group = (query.get("grupo") or [""])[0].strip()
    if selected_group and selected_group not in group_values:
        group_values.append(selected_group)
    groups = [{"name": value, "total": group_counts.get(value, 0)} for value in group_values]

    where, params = cobranca_facet_scope(db, query, "status")
    rows = db.execute(
        f"SELECT status, COUNT(*) AS total FROM cobranca_cases WHERE {where} GROUP BY status",
        params,
    ).fetchall()
    status_counts = {row["status"]: row["total"] for row in rows}
    return {"tipos": tipos, "groups": groups, "statusCounts": status_counts}


COBRANCA_SORTS = {
    "venc_asc": "vencimento ASC, valor DESC",
    "venc_desc": "vencimento DESC, valor DESC",
    "valor_desc": "valor DESC, vencimento ASC",
    "contato_asc": "COALESCE(last_contact_at, '') ASC, vencimento ASC",
    "atualizado": "last_seen DESC, vencimento ASC",
}


def cobranca_summary(db, where, params):
    row = db.execute(
        f"""SELECT COUNT(*) AS rows_total,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 THEN 1 ELSE 0 END) AS cases,
                   COALESCE(SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 THEN valor ELSE 0 END), 0) AS total,
                   SUM(CASE WHEN nao_cobrar = 1 THEN 1 ELSE 0 END) AS deposito_cases,
                   COALESCE(SUM(CASE WHEN nao_cobrar = 1 THEN valor ELSE 0 END), 0) AS deposito_total,
                   SUM(CASE WHEN cancelada = 1 THEN 1 ELSE 0 END) AS cancelada_cases,
                   COALESCE(SUM(CASE WHEN cancelada = 1 THEN valor ELSE 0 END), 0) AS cancelada_total,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 AND vencimento != '' AND vencimento <= date('now', '-30 day') THEN 1 ELSE 0 END) AS old30,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 AND emails = '[]' THEN 1 ELSE 0 END) AS sem_email,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 AND phones = '[]' THEN 1 ELSE 0 END) AS sem_whatsapp,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 AND last_contact_at IS NOT NULL AND substr(last_contact_at, 1, 10) = date('now') THEN 1 ELSE 0 END) AS hoje,
                   SUM(CASE WHEN nao_cobrar = 0 AND cancelada = 0 AND status = 'promessa' THEN 1 ELSE 0 END) AS promessas
            FROM cobranca_cases WHERE {where}""",
        params,
    ).fetchone()
    return {
        "rows": int(row["rows_total"] or 0),
        "cases": int(row["cases"] or 0),
        "total": round(float(row["total"] or 0), 2),
        "depositoCasos": int(row["deposito_cases"] or 0),
        "depositoValor": round(float(row["deposito_total"] or 0), 2),
        "canceladaCasos": int(row["cancelada_cases"] or 0),
        "canceladaValor": round(float(row["cancelada_total"] or 0), 2),
        "old30": int(row["old30"] or 0),
        "semEmail": int(row["sem_email"] or 0),
        "semWhatsapp": int(row["sem_whatsapp"] or 0),
        "cobradosHoje": int(row["hoje"] or 0),
        "promessas": int(row["promessas"] or 0),
    }


def cobranca_log(db, case_id, user, channel, result, notes="", next_contact=None, template_name=""):
    db.execute(
        "INSERT INTO cobranca_history(id, case_id, at, channel, template_name, user_id, user_name, result, notes, next_contact) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            uuid.uuid4().hex,
            case_id,
            now_iso(),
            channel,
            template_name or "",
            user["id"],
            user["display_name"] or user["username"],
            result,
            notes or "",
            next_contact or None,
        ),
    )


def cobranca_import_rows(db, user, rows, source="extensao", period_start="", period_end="", full_scope=False):
    import_id = uuid.uuid4().hex
    stamp = now_iso()
    created = updated = ignored = 0
    seen_keys = set()
    for raw in rows:
        row = cobranca_normalize_row(raw)
        if not row["cliente"] or row["valor"] <= 0:
            ignored += 1
            continue
        key = cobranca_case_key(row)
        if key in seen_keys:
            ignored += 1
            continue
        seen_keys.add(key)
        existing = db.execute("SELECT * FROM cobranca_cases WHERE case_key = ?", (key,)).fetchone()
        emails = list(dict.fromkeys([*(cobranca_clean_list(existing["emails"]) if existing else []), *row["emails"]]))
        phones = list(dict.fromkeys([*(cobranca_clean_list(existing["phones"]) if existing else []), *row["phones"]]))
        if existing:
            updated += 1
            reopen = existing["status"] == "pago"
            db.execute(
                """UPDATE cobranca_cases SET cliente = ?, documento = ?, empresa = ?, grupo = ?, departamento = ?,
                       cd_associado = ?, tipo_parcela = ?, tipo_pagamento = ?, competencia = ?, parcela = ?,
                       situacao = ?, vencimento = ?, valor = ?, emails = ?, phones = ?, last_seen = ?,
                       nao_cobrar = ?, cancelada = ?,
                       status = CASE WHEN ? THEN 'aberto' ELSE status END,
                       closed_at = CASE WHEN ? THEN NULL ELSE closed_at END
                   WHERE id = ?""",
                (
                    row["cliente"], row["documento"], row["empresa"], row["grupo"], row["departamento"],
                    row["cd_associado"], row["tipo_parcela"], row["tipo_pagamento"], row["competencia"], row["parcela"],
                    row["situacao"], row["vencimento"], row["valor"], json.dumps(emails, ensure_ascii=False),
                    json.dumps(phones, ensure_ascii=False), stamp, row["nao_cobrar"], row["cancelada"],
                    1 if reopen else 0, 1 if reopen else 0,
                    existing["id"],
                ),
            )
            if reopen:
                cobranca_log(db, existing["id"], user, "sistema", "reaberto", "O caso voltou a aparecer no relatório do S4E.")
        else:
            created += 1
            db.execute(
                """INSERT INTO cobranca_cases(id, case_key, cliente, documento, empresa, grupo, departamento,
                       cd_associado, tipo_parcela, tipo_pagamento, competencia, parcela, situacao, vencimento,
                       valor, emails, phones, status, origem, import_id, first_seen, last_seen, nao_cobrar, cancelada)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto', 's4e', ?, ?, ?, ?, ?)""",
                (
                    uuid.uuid4().hex, key, row["cliente"], row["documento"], row["empresa"], row["grupo"],
                    row["departamento"], row["cd_associado"], row["tipo_parcela"], row["tipo_pagamento"],
                    row["competencia"], row["parcela"], row["situacao"], row["vencimento"], row["valor"],
                    json.dumps(emails, ensure_ascii=False), json.dumps(phones, ensure_ascii=False),
                    import_id, stamp, stamp, row["nao_cobrar"], row["cancelada"],
                ),
            )
    closed = 0
    # Com filtro no S4E, um caso ausente pode estar só fora do filtro: não baixar.
    if seen_keys and full_scope:
        placeholders = ",".join("?" for _ in seen_keys)
        stale = db.execute(
            f"""SELECT id FROM cobranca_cases
                WHERE status IN ({','.join('?' for _ in COBRANCA_ACTIVE_STATUSES)})
                  AND last_seen < ? AND case_key NOT IN ({placeholders})""",
            (*COBRANCA_ACTIVE_STATUSES, stamp, *seen_keys),
        ).fetchall()
        for item in stale:
            closed += 1
            db.execute(
                "UPDATE cobranca_cases SET status = 'pago', closed_at = ?, next_contact = NULL WHERE id = ?",
                (stamp, item["id"]),
            )
            cobranca_log(db, item["id"], user, "sistema", "baixa_automatica", "Saiu do relatório de atrasados do S4E.")
    sem_email = db.execute(
        "SELECT COUNT(*) FROM cobranca_cases WHERE last_seen = ? AND emails = '[]'", (stamp,)
    ).fetchone()[0]
    sem_whatsapp = db.execute(
        "SELECT COUNT(*) FROM cobranca_cases WHERE last_seen = ? AND phones = '[]'", (stamp,)
    ).fetchone()[0]
    db.execute(
        """INSERT INTO cobranca_imports(id, at, user_id, user_name, source, total, criados, atualizados, baixados, ignorados, sem_email, sem_whatsapp, period_start, period_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            import_id, stamp, user["id"], user["display_name"] or user["username"], source,
            len(rows), created, updated, closed, ignored, int(sem_email or 0), int(sem_whatsapp or 0),
            cobranca_date_iso(period_start), cobranca_date_iso(period_end),
        ),
    )
    return {
        "importId": import_id,
        "total": len(rows),
        "criados": created,
        "atualizados": updated,
        "baixados": closed,
        "ignorados": ignored,
        "semEmail": int(sem_email or 0),
        "semWhatsapp": int(sem_whatsapp or 0),
    }


def s4e_import_into_cobranca(user_snapshot, rows, source="s4e-portal", period_start="", period_end="", full_scope=True):
    with connection() as db:
        return cobranca_import_rows(
            db, user_snapshot, rows, source=source,
            period_start=period_start, period_end=period_end, full_scope=full_scope,
        )


# ── Conta do S4E salva no portal ─────────────────────────────────────────────
# A senha só é guardada se a máquina conseguir protegê-la com o DPAPI do Windows:
# o texto cifrado não pode ser aberto em outro computador nem lido fora da sessão
# do usuário que roda o portal.
S4E_ACCOUNT_KEY = "s4e_account"


def protect_secret(text):
    if not text:
        return ""
    return base64.b64encode(_dpapi(text.encode("utf-8"), protect=True)).decode("ascii")


def reveal_secret(value):
    if not value:
        return ""
    try:
        return _dpapi(base64.b64decode(value), protect=False).decode("utf-8")
    except Exception:  # noqa: BLE001 - segredo de outra máquina vira "sem conta"
        return ""


def s4e_account_config(db):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (S4E_ACCOUNT_KEY,)).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def s4e_account_public(config):
    cpf = str(config.get("cpf") or "")
    masked = f"***.***.{cpf[5:8]}-{cpf[8:]}" if len(cpf) == 11 else ""
    return {
        "configured": bool(config.get("password")),
        "name": config.get("name") or "",
        "cpf": masked,
        "savedAt": config.get("savedAt") or "",
        "savedBy": config.get("savedBy") or "",
    }


def s4e_account_save(db, cpf, protected_password, name, saved_by):
    config = {
        "cpf": cpf,
        "password": protected_password,
        "name": name or "",
        "savedAt": now_iso(),
        "savedBy": saved_by or "",
    }
    db.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (S4E_ACCOUNT_KEY, json.dumps(config, ensure_ascii=False)),
    )
    return config


def s4e_account_delete(db):
    db.execute("DELETE FROM meta WHERE key = ?", (S4E_ACCOUNT_KEY,))


def s4e_saved_credentials():
    with connection() as db:
        config = s4e_account_config(db)
    if not config.get("password"):
        return None
    password = reveal_secret(config["password"])
    if not password:
        return None
    return (config.get("cpf") or "", password)


s4e.set_credentials_provider(s4e_saved_credentials)


# ── Cobrança em lote por e-mail ───────────────────────────────────────────────
def cobranca_smtp_config(db):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (COBRANCA_SMTP_KEY,)).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def cobranca_smtp_public(config):
    return {
        "configured": bool(config.get("host") and config.get("fromEmail")),
        "host": config.get("host") or "",
        "port": int(config.get("port") or 587),
        "user": config.get("user") or "",
        "fromName": config.get("fromName") or "",
        "fromEmail": config.get("fromEmail") or "",
        "useTls": bool(config.get("useTls", True)),
        "hasPassword": bool(config.get("password")),
    }


def cobranca_graph_config(db):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (COBRANCA_GRAPH_KEY,)).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def cobranca_graph_public(config):
    return {
        "connected": bool(config.get("refreshToken")),
        "account": config.get("account") or "",
        "connectedAt": config.get("connectedAt") or "",
    }


def cobranca_graph_save(db, config):
    db.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (COBRANCA_GRAPH_KEY, json.dumps(config, ensure_ascii=False)),
    )


def cobranca_group_cc_map(db):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (COBRANCA_GROUP_CC_KEY,)).fetchone()
    data = None
    if row:
        try:
            data = json.loads(row["value"])
        except (TypeError, ValueError):
            data = None
    entries = data.get("groups") if isinstance(data, dict) else None
    groups = {}
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()[:160]
        if not name:
            continue
        emails = [
            value for value in cobranca_clean_list(entry.get("emails"))
            if cobranca_email_is_valid(value)
        ]
        groups[name.upper()] = {"name": name, "emails": emails}
    return groups


def cobranca_group_cc_save(db, entries):
    groups = {}
    ignored = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        name = re.sub(r"\s+", " ", str(entry.get("name") or "")).strip()[:160]
        if not name:
            continue
        emails = []
        for value in cobranca_clean_list(entry.get("emails")):
            email = value.strip()
            if not email or email in emails:
                continue
            if not cobranca_email_is_valid(email):
                ignored.append({"group": name, "email": email})
                continue
            emails.append(email)
        if not emails:
            continue
        groups[name.upper()] = {"name": name, "emails": emails}
    payload = {"groups": sorted(groups.values(), key=lambda item: item["name"].lower())}
    db.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (COBRANCA_GROUP_CC_KEY, json.dumps(payload, ensure_ascii=False)),
    )
    return payload, ignored


def cobranca_group_cc_public(db):
    groups = cobranca_group_cc_map(db)
    counts = {}
    rows = db.execute(
        f"SELECT id, documento, cliente, empresa, grupo FROM cobranca_cases "
        f"WHERE status IN ({','.join('?' for _ in COBRANCA_ACTIVE_STATUSES)})",
        COBRANCA_ACTIVE_STATUSES,
    ).fetchall()
    for row in rows:
        grupo = str(row["grupo"] or "").strip()
        if not grupo:
            continue
        key = cobranca_company_key_for_row(row)
        counts.setdefault(grupo.upper(), {"name": grupo, "keys": set()})["keys"].add(key)
    items = []
    for normalized, entry in counts.items():
        config = groups.get(normalized)
        items.append({
            "name": (config or {}).get("name") or entry["name"],
            "emails": (config or {}).get("emails", []),
            "empresas": len(entry["keys"]),
            "configurado": bool(config),
        })
    for normalized, config in groups.items():
        if normalized not in counts:
            items.append({
                "name": config["name"],
                "emails": config["emails"],
                "empresas": 0,
                "configurado": True,
            })
    items.sort(key=lambda item: item["name"].lower())
    return {"groups": items}


def cobranca_lote_texto(db):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (COBRANCA_LOTE_KEY,)).fetchone()
    data = None
    if row:
        try:
            data = json.loads(row["value"])
        except (TypeError, ValueError):
            data = None
    if not isinstance(data, dict):
        data = {}
    return {
        "subject": str(data.get("subject") or COBRANCA_BULK_SUBJECT)[:200],
        "body": str(data.get("body") or COBRANCA_BULK_BODY)[:4000],
    }


def cobranca_brl(value):
    text = f"{float(value or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {text}"


def cobranca_date_br(value):
    iso = cobranca_date_iso(value)
    return f"{iso[8:10]}/{iso[5:7]}/{iso[0:4]}" if iso else "—"


def cobranca_lote_plan(db, skip_today=True, where="1=1", params=(), skip_due_today=True):
    active = f"status IN ({','.join('?' for _ in COBRANCA_ACTIVE_STATUSES)})"
    scope = f"{active} AND ({where})"
    scope_params = (*COBRANCA_ACTIVE_STATUSES, *params)
    today = date.today().isoformat()
    vencendo_hoje = db.execute(
        f"SELECT COUNT(*) AS casos, COALESCE(SUM(valor), 0) AS total FROM cobranca_cases "
        f"WHERE {scope} AND nao_cobrar = 0 AND cancelada = 0 AND vencimento = ?",
        (*scope_params, today),
    ).fetchone()
    deposito = db.execute(
        f"SELECT COUNT(*) AS casos, COALESCE(SUM(valor), 0) AS total FROM cobranca_cases "
        f"WHERE {scope} AND nao_cobrar = 1",
        scope_params,
    ).fetchone()
    cancelada = db.execute(
        f"SELECT COUNT(*) AS casos, COALESCE(SUM(valor), 0) AS total FROM cobranca_cases "
        f"WHERE {scope} AND cancelada = 1",
        scope_params,
    ).fetchone()
    rows = db.execute(
        f"SELECT * FROM cobranca_cases WHERE {scope} AND nao_cobrar = 0 AND cancelada = 0"
        + (" AND vencimento < ?" if skip_due_today else "")
        + " ORDER BY vencimento ASC, cliente COLLATE NOCASE",
        (*scope_params, today) if skip_due_today else scope_params,
    ).fetchall()
    cc_map = cobranca_group_cc_map(db)
    buckets = {}
    for row in rows:
        key = cobranca_company_key_for_row(row)
        bucket = buckets.get(key)
        if bucket is None:
            bucket = {"key": key, "rows": []}
            buckets[key] = bucket
        bucket["rows"].append(row)
    companies = []
    sem_email = 0
    cobrados_hoje = 0
    default_empresas = 0
    default_casos = 0
    default_valor = 0.0
    for bucket in buckets.values():
        company = cobranca_company_bucket_payload(bucket, cc_map)
        company["email"] = company["emails"][0] if company["emails"] else ""
        company["cobradoHoje"] = str(company["lastContactAt"] or "")[:10] == today
        if not company["temEmail"]:
            sem_email += 1
        if company["cobradoHoje"]:
            cobrados_hoje += 1
        if company["temEmail"] and not (skip_today and company["cobradoHoje"]):
            default_empresas += 1
            default_casos += company["casesCobrar"]
            default_valor += company["totalCobrar"]
        companies.append(company)
    companies.sort(key=lambda item: (item["totalCobrar"], item["diasAtraso"]), reverse=True)
    return {
        "companies": companies,
        "depositoCasos": int(deposito["casos"] or 0),
        "depositoValor": round(float(deposito["total"] or 0), 2),
        "canceladaCasos": int(cancelada["casos"] or 0),
        "canceladaValor": round(float(cancelada["total"] or 0), 2),
        "semEmail": sem_email,
        "cobradosHoje": cobrados_hoje,
        "vencendoHojeCasos": int(vencendo_hoje["casos"] or 0),
        "vencendoHojeValor": round(float(vencendo_hoje["total"] or 0), 2),
        "totalEmpresas": default_empresas,
        "totalCasos": default_casos,
        "totalValor": round(default_valor, 2),
        "excedente": max(0, default_empresas - COBRANCA_LOTE_LIMIT),
    }


def cobranca_lote_public(plan):
    companies = [
        {
            "key": company["key"],
            "nome": company["nome"],
            "documento": company["documento"],
            "grupo": company["grupo"],
            "email": company["email"],
            "emails": company["emails"],
            "cc": company.get("cc") or [],
            "cases": company["casesCobrar"],
            "total": company["totalCobrar"],
            "cadastros": company["cadastros"],
            "cobradoHoje": company.get("cobradoHoje", False),
            "temEmail": company["temEmail"],
            "composicao": [
                {
                    "key": entry["key"],
                    "label": entry["label"],
                    "labelPlural": entry["labelPlural"],
                    "count": entry["count"],
                    "total": entry["total"],
                }
                for entry in company["composicao"]
            ],
        }
        for company in plan["companies"]
    ]
    preview = None
    first = next((company for company in plan["companies"] if company["temEmail"]), None)
    if first is not None:
        message = cobranca_company_message(first)
        preview = {
            "key": first["key"],
            "empresa": first["nome"],
            "subject": message["subject"],
            "text": message["text"],
            "html": message["html"],
            "cc": first.get("cc") or [],
        }
    return {
        "companies": companies,
        "preview": preview,
        "depositoCasos": plan["depositoCasos"],
        "depositoValor": plan["depositoValor"],
        "canceladaCasos": plan["canceladaCasos"],
        "canceladaValor": plan["canceladaValor"],
        "semEmail": plan["semEmail"],
        "cobradosHoje": plan["cobradosHoje"],
        "vencendoHojeCasos": plan["vencendoHojeCasos"],
        "vencendoHojeValor": plan["vencendoHojeValor"],
        "totalEmpresas": plan["totalEmpresas"],
        "totalCasos": plan["totalCasos"],
        "totalValor": plan["totalValor"],
        "excedente": plan["excedente"],
        "limite": COBRANCA_LOTE_LIMIT,
    }


def cobranca_smtp_connect(config):
    host = str(config.get("host") or "").strip()
    port = int(config.get("port") or 587)
    context = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
        server.ehlo()
        if config.get("useTls", True):
            server.starttls(context=context)
            server.ehlo()
    if config.get("user"):
        server.login(str(config["user"]), str(config.get("password") or ""))
    return server


class CobrancaGraphError(RuntimeError):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def cobranca_graph_request(url, form=None, payload=None, token="", timeout=45, extra_headers=None):
    headers = {"Accept": "application/json"}
    if extra_headers:
        headers.update({str(k): str(v) for k, v in extra_headers.items()})
    data = None
    if form is not None:
        data = urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data is not None else "GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    try:
        body = json.loads(raw.decode("utf-8")) if raw else {}
    except (TypeError, ValueError):
        body = {}
    return status, body if isinstance(body, dict) else {}


def cobranca_graph_device_start():
    return cobranca_graph_request(
        f"{COBRANCA_GRAPH_AUTHORITY}/devicecode",
        form={"client_id": COBRANCA_GRAPH_CLIENT_ID, "scope": COBRANCA_GRAPH_SCOPES},
    )


def cobranca_graph_token_request(form):
    return cobranca_graph_request(f"{COBRANCA_GRAPH_AUTHORITY}/token", form=form)


def cobranca_graph_account(token):
    # O id_token traz o login confirmado; é dele que sai o endereço da conta.
    id_token = str(token.get("id_token") or "")
    parts = id_token.split(".")
    if len(parts) < 2:
        return ""
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(raw.decode("utf-8"))
    except (TypeError, ValueError):
        return ""
    if not isinstance(claims, dict):
        return ""
    for key in ("preferred_username", "upn", "email"):
        value = str(claims.get(key) or "").strip()
        if "@" in value:
            return value
    return ""


def cobranca_graph_access_token(db, config):
    refresh = str(config.get("refreshToken") or "")
    if not refresh:
        raise CobrancaGraphError("Conta Microsoft não conectada.")
    status, token = cobranca_graph_token_request({
        "grant_type": "refresh_token",
        "client_id": COBRANCA_GRAPH_CLIENT_ID,
        "refresh_token": refresh,
        "scope": COBRANCA_GRAPH_SCOPES,
    })
    access = str(token.get("access_token") or "")
    if status >= 400 or not access:
        detail = token.get("error_description") or token.get("error") or "falha ao renovar o acesso"
        invalid = str(token.get("error") or "") in ("invalid_grant", "interaction_required")
        raise CobrancaGraphError(
            "A conexão com a conta Microsoft expirou. Conecte a conta de novo."
            if invalid else f"Não foi possível renovar o acesso Microsoft: {str(detail)[:240]}",
            401 if invalid else status,
        )
    # A Microsoft troca o refresh token a cada renovação; guardar o novo mantém a conexão viva.
    if token.get("refresh_token"):
        config["refreshToken"] = token["refresh_token"]
        config["connectedAt"] = config.get("connectedAt") or now_iso()
        account = cobranca_graph_account(token)
        if account:
            config["account"] = account
        cobranca_graph_save(db, config)
    return access


def cobranca_graph_send(token, to_email, subject, body, reply_to="", content_type="Text", cc=None):
    mail = {
        "subject": subject,
        "body": {"contentType": content_type, "content": body},
        "toRecipients": [{"emailAddress": {"address": to_email}}],
    }
    cc_list = [value for value in (cc or []) if value and value != to_email]
    if cc_list:
        mail["ccRecipients"] = [{"emailAddress": {"address": value}} for value in cc_list]
    if reply_to:
        mail["replyTo"] = [{"emailAddress": {"address": reply_to}}]

    # Identificador do próprio envio: fica nos cabeçalhos e no suporte da Microsoft,
    # servindo de referência para conferir a mensagem no histórico do provedor.
    def attempt(request_id):
        return cobranca_graph_request(
            "https://graph.microsoft.com/v1.0/me/sendMail",
            payload={"message": mail, "saveToSentItems": True},
            token=token,
            extra_headers={
                "client-request-id": request_id,
                "return-client-request-id": "true",
            },
        )

    request_id = str(uuid.uuid4())
    status, data = attempt(request_id)
    if status == 429:
        # Limite de envio da Microsoft: espera um pouco e tenta uma vez.
        time.sleep(5)
        request_id = str(uuid.uuid4())
        status, data = attempt(request_id)
    if status in (200, 202):
        return request_id
    detail = (data.get("error") or {}).get("message") if isinstance(data.get("error"), dict) else ""
    raise CobrancaGraphError(
        f"Microsoft Graph recusou o envio ({status}): {str(detail or 'sem detalhe')[:200]}",
        status,
    )


def cobranca_claim_send(company_key):
    with _cobranca_inflight_lock:
        if company_key in _cobranca_inflight:
            return False
        _cobranca_inflight.add(company_key)
        return True


def cobranca_release_send(company_key):
    with _cobranca_inflight_lock:
        _cobranca_inflight.discard(company_key)


def cobranca_send_claim_key(company):
    return str((company or {}).get("key") or "")


def cobranca_lote_mark(db, user, company):
    stamp = now_iso()
    cc = [value for value in (company.get("cc") or []) if value]
    nota = f"Cobrança em lote enviada para {company['email']}."
    if cc:
        nota += " Em cópia: " + ", ".join(cc) + "."
    for item in company["casos"]:
        db.execute(
            "UPDATE cobranca_cases SET last_contact_at = ?, contact_count = contact_count + 1, "
            "status = CASE WHEN status IN ('aberto', 'sem_contato') THEN 'em_cobranca' ELSE status END "
            "WHERE id = ?",
            (stamp, item["id"]),
        )
        cobranca_log(
            db, item["id"], user, "email", "enviado",
            nota,
            template_name="Cobrança em lote",
        )


def cobranca_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'cobrancaScreen'",
        (user["id"],),
    ).fetchone())


def require_cobranca(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not cobranca_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela de Cobrança."}, 403)
        return None
    return user


APURACAO_MES_PT = (
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
)
APURACAO_CEARA = "Ceará"
APURACAO_DIR = ROOT / "apuracao"
APURACAO_MAP_SEED = (
    ("SINTEG-SEAC", "", "SINTEG"),
    ("CCT SINDIMOTOS", "", "SINDIMOTOS"),
    ("ACT SINDIMOTOS", "", "SINDIMOTOS"),
    ("SINCOPECE", "", "SINDIMOTOS"),
    ("SINTRASECE", "", "SINTRASECE"),
    ("FECOMERCIO MAIS SAUDE", "", "FECOMERCIO"),
    ("SINATC EXPANSÃO", "", "SINATC EXP"),
    ("SINATC EXPANSÃO PANIFICAÇÃO", "", "SINATC EXP"),
    ("SINATC EXPANSÃO PRODUÇÃO", "", "SINATC EXP"),
    ("SINATC PANIFICAÇÃO", "", "SINATC"),
    ("SINATC PRODUÇÃO", "", "SINATC"),
    ("SINDCOMERCIO NOROESTE/PARACATU", "P4X PARACATU", "PARACATU"),
    ("SINDCOMERCIO NOROESTE/PARACATU", "DEPOSITO BANCARIO", "PARACATU ESP."),
    ("SITIAL", "", "SITIAL"),
    ("SEAC-RJ", "", "SEAC RJ"),
    ("SINTRUCAD ACT", "", "SINTRUCAD ACT"),
    ("SINDIERJ", "", "SINDIERJ ESP."),
    ("SIND NITEROI", "", "NITEROI ESP."),
    ("SIND NITEROI TAXA SINDICAL", "", "NITEROI ESP."),
    ("SIND ROV NOVA IGUAÇU", "", "NOVA IGUAÇU ESP."),
    ("SIND ROV NOVA IGUAÇU CAT URBANO", "", "NOVA IGUAÇU ESP."),
    ("SIND ROV NOVA IGUAÇU EMPRESARIAL", "", "NOVA IGUAÇU ESP."),
    ("SINDICATO CARGA RIO CCT", "", "CARGA CCT-ACT ESP."),
    ("SINDICATO CARGA RIO ACT", "", "CARGA CCT-ACT ESP."),
    ("SINTRUCAD-FRETAMENTO", "", "FRETAMENTO ESP."),
    ("STIAPAR", "", "STIAPAR ESP."),
    ("SINTEEP-RO", "", "SINTEEP-RO"),
    ("SINPRO-RO", "", "SINPRO-RO"),
    ("SINTRARAÇÕES", "", "SINTRARAÇÕES"),
)
_apuracao_job = {
    "id": None, "running": False, "phase": "", "message": "",
    "percent": 0, "startedAt": None, "finishedAt": None,
    "runId": None, "competencia": None, "error": None,
}
_apuracao_job_lock = threading.Lock()


def apuracao_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'apuracaoScreen'",
        (user["id"],),
    ).fetchone())


def require_apuracao(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not apuracao_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela de Apuração."}, 403)
        return None
    return user


def _apuracao_norm(value):
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = re.sub(r"[-/]", " ", text)
    return re.sub(r"\s+", " ", text).strip().upper()


def apuracao_seed_map(db):
    if db.execute("SELECT 1 FROM meta WHERE key = 'apuracao_map_seed_v1'").fetchone():
        return
    for grupo, tipo_pagamento, grupo_mae in APURACAO_MAP_SEED:
        db.execute(
            "INSERT OR IGNORE INTO apuracao_map(id, grupo, tipo_pagamento, grupo_mae) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), grupo, tipo_pagamento, grupo_mae),
        )
    db.execute("INSERT INTO meta (key, value) VALUES ('apuracao_map_seed_v1', ?)", (now_iso(),))


def _apuracao_map_entries(db):
    return [
        (_apuracao_norm(row["grupo"]), _apuracao_norm(row["tipo_pagamento"]), row["grupo_mae"])
        for row in db.execute("SELECT grupo, tipo_pagamento, grupo_mae FROM apuracao_map").fetchall()
    ]


def apuracao_resolve_mae(entries, grupo, tipo_pagamento):
    g = _apuracao_norm(grupo)
    t = _apuracao_norm(tipo_pagamento)
    if not g:
        return APURACAO_CEARA
    for entry_g, entry_t, mae in entries:
        if entry_g == g and entry_t == t:
            return mae
    for entry_g, entry_t, mae in entries:
        if entry_g == g and not entry_t:
            return mae
    return str(grupo).strip()


def apuracao_competencia_label(year, month):
    return f"{APURACAO_MES_PT[month - 1]}/{year}"


def apuracao_competencia_options():
    today = date.today()
    options = []
    year, month = today.year, today.month
    # Keep two full years available for historical rateios and reprocessamentos.
    for _ in range(24):
        options.append(apuracao_competencia_label(year, month))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    return options


def apuracao_fetch_window(label):
    match = re.match(r"^\s*([A-Za-zÀ-ÿ]+)\s*/\s*(\d{4})\s*$", str(label or ""))
    if not match:
        return None
    meses = {_apuracao_norm(nome): index + 1 for index, nome in enumerate(APURACAO_MES_PT)}
    month = meses.get(_apuracao_norm(match.group(1)))
    year = int(match.group(2))
    if not month or not (2000 <= year <= 2100):
        return None
    last_day = calendar.monthrange(year, month)[1]
    start = f"01/{month:02d}/{year}"
    end = f"{last_day:02d}/{month:02d}/{year}"
    return start, end


def apuracao_source_windows(label):
    """Consulta mês anterior e mês atual separadamente para evitar timeout no S4E."""
    window = apuracao_fetch_window(label)
    if not window:
        return []
    start = datetime.strptime(window[0], "%d/%m/%Y").date()
    previous_end = start - timedelta(days=1)
    previous_start = f"01/{previous_end.month:02d}/{previous_end.year}"
    return [(previous_start, previous_end.strftime("%d/%m/%Y")), window]


def apuracao_row_in_credit_month(row, competencia_label):
    if _apuracao_norm(row.get("competencia")) == _apuracao_norm(competencia_label):
        return True
    window = apuracao_fetch_window(competencia_label)
    credit = rateio_date_text(row.get("dataCredito"))
    if not window or not credit:
        return False
    target = datetime.strptime(window[0], "%d/%m/%Y").date()
    parsed = datetime.strptime(credit, "%Y-%m-%d").date()
    return parsed.year == target.year and parsed.month == target.month


def apuracao_job_status():
    with _apuracao_job_lock:
        return dict(_apuracao_job)


def _apuracao_job_update(**fields):
    with _apuracao_job_lock:
        _apuracao_job.update(fields)


def _apuracao_timings(value):
    try:
        data = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): round(float(seconds), 1) for key, seconds in data.items()
            if isinstance(seconds, (int, float))}


def _auto_within(value, hours):
    age = _auto_age_minutes(value)
    return age is not None and age < hours * 60


def apuracao_nf_cache(db, empty_ttl_hours=24):
    cache = {}
    for row in db.execute("SELECT lot, links, fetched_at FROM apuracao_nf_lots"):
        try:
            items = json.loads(row["links"] or "[]")
        except (TypeError, ValueError):
            continue
        links = {}
        for item in items if isinstance(items, list) else []:
            if isinstance(item, list) and len(item) == 3:
                links[(str(item[0]), str(item[1]))] = str(item[2])
        # Lote sem link é memorizado por um dia: evita reconsultar o S4E a cada
        # apuração, mas permite que uma falha passageira seja corrigida depois.
        if not links and not _auto_within(row["fetched_at"], empty_ttl_hours):
            continue
        cache[str(row["lot"])] = links
    return cache


def apuracao_nf_cache_save(db, updates):
    for lot, links in updates.items():
        db.execute(
            "INSERT INTO apuracao_nf_lots(lot, links, fetched_at) VALUES (?, ?, ?) "
            "ON CONFLICT(lot) DO UPDATE SET links = excluded.links, fetched_at = excluded.fetched_at",
            (lot, json.dumps([[code, nf, url] for (code, nf), url in links.items()], ensure_ascii=False), now_iso()),
        )


def _apuracao_latest_run(db, competencia_label):
    return db.execute(
        "SELECT * FROM apuracao_runs WHERE competencia_label = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1",
        (competencia_label,),
    ).fetchone()


APURACAO_KEEP_RUNS = 24


def apuracao_prune_runs(db, competencia_label, keep=APURACAO_KEEP_RUNS):
    # A apuração automática roda várias vezes ao dia: guardar as execuções mais
    # recentes mantém o histórico útil sem inflar o banco.
    runs = db.execute(
        "SELECT id, file_path FROM apuracao_runs "
        "WHERE competencia_label = ? AND status != 'running' ORDER BY started_at DESC",
        (competencia_label,),
    ).fetchall()
    stale = runs[keep:]
    for run in stale:
        db.execute("DELETE FROM apuracao_rows WHERE run_id = ?", (run["id"],))
        db.execute("DELETE FROM apuracao_runs WHERE id = ?", (run["id"],))
    return [run["file_path"] for run in stale if run["file_path"]]


def apuracao_store_run(db, run_id, rows, competencia_label):
    entries = _apuracao_map_entries(db)
    empresas = {}
    selected = [row for row in rows if apuracao_row_in_credit_month(row, competencia_label) and float(row.get("valor") or 0) > 0]
    for row in sorted(selected, key=lambda item: datetime.strptime(item["vencimento"], "%d/%m/%Y")):
        documento = re.sub(r"\D", "", str(row.get("documento") or ""))
        if len(documento) != 14:
            continue
        mae = apuracao_resolve_mae(entries, row["grupo"], row["tipoPagamento"])
        venc = row["vencimento"]
        # O sistema de planilhas substitui CNPJ + mês de vencimento dentro da mesma aba.
        key = (mae, documento, venc[3:])
        empresas[key] = row
    total_docs = set()
    paid_docs = set()
    for (mae, documento, _), item in empresas.items():
        pago = int(bool(item["dataCredito"]))
        total_docs.add(documento)
        if pago:
            paid_docs.add(documento)
        record = {
            "id": str(uuid.uuid4()), "run_id": run_id, "grupo_mae": mae, "grupo_empresa": item["grupo"],
            "empresa": item["cliente"], "documento": documento, "vidas": item["vidas"], "vencimento": item["vencimento"],
            "valor": item["valor"], "data_pagamento": item.get("dataPagamento", ""), "data_credito": item.get("dataCredito", ""),
            "valor_recebido": item.get("valorRecebido", 0), "pago": pago, "tipo_pagamento": item.get("tipoPagamento", ""),
            "competencia": item.get("competencia") or competencia_label, "nf": item.get("nf", ""), "nf_url": item.get("nfUrl", ""),
            "imposto": item.get("imposto", 0), "multa": item.get("multa", 0), "acrescimo": item.get("acrescimo", 0),
            "acrescimo_avulso": item.get("acrescimoAvulso", 0), "desconto": item.get("desconto", 0),
            "desconto_pagamento": item.get("descontoPagamento", 0), "tarifa": item.get("tarifa", 0), "titulo": item.get("titulo", 0),
            "taxa": item.get("taxa", 0), "empresa_s4e": item.get("empresa", ""), "departamento": item.get("departamento", ""),
            "situacao": item.get("situacao", ""), "gerado": item.get("gerado", ""), "tipo_parcela": item.get("tipoParcela", ""),
            "tipo_recebimento": item.get("tipoRecebimento", ""), "parcela": item.get("parcela", ""), "nf_lote": item.get("nfLote", ""),
            "emissao": item.get("emissao", ""), "vl_plano": item.get("vlPlano", 0), "vl_orto": item.get("vlOrto", 0),
            "vl_prorata": item.get("vlProRata", 0), "vendedor": item.get("vendedor", ""),
        }
        columns = tuple(record)
        db.execute(f"INSERT INTO apuracao_rows({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(record.values()))
    db.execute(
        "UPDATE apuracao_runs SET total_rows = ?, total_empresas = ?, pagas = ? WHERE id = ?",
        (len(selected), len(total_docs), len(paid_docs), run_id),
    )
    return {"empresas": len(total_docs), "pagas": len(paid_docs)}


def apuracao_start_run(competencia_label, mode="manual", user_name=""):
    if apuracao_fetch_window(competencia_label) is None:
        raise s4e.ConnectorError("Competência inválida. Use o formato como Outubro/2026.")
    run_id = str(uuid.uuid4())
    with _apuracao_job_lock:
        if _apuracao_job["running"]:
            raise s4e.ConnectorError("Já existe uma apuração em andamento. Aguarde terminar.")
        previous_job = dict(_apuracao_job)
        _apuracao_job.update(
            id=uuid.uuid4().hex, running=True, phase="inicio", message="Iniciando a apuração...",
            percent=2, startedAt=datetime.now().isoformat(timespec="seconds"),
            finishedAt=None, runId=run_id, competencia=competencia_label, error=None, timings={},
        )
    inserted = False
    try:
        with connection() as db:
            if system_lock_state(db)[0]:
                raise s4e.ConnectorError("O portal está bloqueado pela administração.")
            db.execute(
                "INSERT INTO apuracao_runs(id, competencia, competencia_label, mode, status, started_at, created_by) "
                "VALUES (?, ?, ?, ?, 'running', ?, ?)",
                (run_id, competencia_label, competencia_label, mode, now_iso(), user_name),
            )
            db.commit()
            inserted = True
        worker = threading.Thread(
            target=_apuracao_worker, args=(run_id, competencia_label, user_name),
            name="apuracao-run", daemon=True,
        )
        worker.start()
    except Exception as exc:
        try:
            if inserted:
                with connection() as db:
                    db.execute(
                        "UPDATE apuracao_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
                        (now_iso(), str(exc), run_id),
                    )
                    db.commit()
        finally:
            with _apuracao_job_lock:
                _apuracao_job.clear()
                _apuracao_job.update(previous_job)
        raise
    return run_id


def _apuracao_worker(run_id, competencia_label, user_name):
    started = time.monotonic()
    timings = {}

    def mark(name):
        timings[name] = round(time.monotonic() - started, 1)

    def progress(done, total, message):
        _apuracao_job_update(
            phase="s4e", message=message,
            phaseStartedAt=datetime.now().isoformat(timespec="seconds"),
            percent=min(70, 10 + round(55 * done)),
        )

    try:
        http_session = s4e.ensure_session()
        windows = apuracao_source_windows(competencia_label)
        rows = []
        for window_index, (start, end) in enumerate(windows):
            def window_progress(done, total, message, index=window_index):
                fraction = (index + (done / max(total, 1))) / max(len(windows), 1)
                progress(fraction, 1, f"{message} ({index + 1} de {len(windows)} meses)")
            try:
                month_rows = s4e.fetch_faturamento_rows(http_session, start, end, window_progress)
            except s4e.ConnectorError as exc:
                if "expirou" not in str(exc):
                    raise
                s4e.disconnect()
                _apuracao_job_update(message="Sessão do S4E expirada. Entrando novamente com a conta salva...", percent=5)
                http_session = s4e.ensure_session()
                month_rows = s4e.fetch_faturamento_rows(http_session, start, end, window_progress)
            rows.extend(month_rows)
        mark("relatorio")

        selected_rows = [row for row in rows if apuracao_row_in_credit_month(row, competencia_label)]
        with connection() as db:
            cached_lots = apuracao_nf_cache(db)
        cache_updates = {}

        def nf_progress(done, total, message):
            _apuracao_job_update(phase="notas", message=message, percent=70 + round(8 * done / max(total, 1)))

        s4e.attach_faturamento_nf_links(
            http_session, selected_rows, nf_progress,
            cached=cached_lots,
            on_lot=lambda lot, links: cache_updates.__setitem__(lot, links),
        )
        mark("notas")
        if cache_updates:
            with connection() as db:
                apuracao_nf_cache_save(db, cache_updates)
                db.commit()

        _apuracao_job_update(phase="apuracao", percent=80, message="Apurando empresas por grupo...")
        with connection() as db:
            stats = apuracao_store_run(db, run_id, rows, competencia_label)
            db.commit()
        mark("apuracao")

        _apuracao_job_update(phase="planilha", percent=92, message="Gerando a planilha da semana...")
        path = apuracao_gerar_planilha(run_id)
        mark("planilha")
        timings["total"] = round(time.monotonic() - started, 1)
        with connection() as db:
            db.execute(
                "UPDATE apuracao_runs SET file_path = ?, status = 'done', finished_at = ?, error = NULL, timings = ? WHERE id = ?",
                (str(path), now_iso(), json.dumps(timings), run_id),
            )
            stale_files = apuracao_prune_runs(db, competencia_label)
            db.commit()
        for stale_file in stale_files:
            try:
                Path(stale_file).unlink()
            except OSError:
                pass

        _apuracao_job_update(
            phase="fim", percent=100, running=False,
            finishedAt=datetime.now().isoformat(timespec="seconds"),
            timings=timings,
            message=(
                f"Apuração pronta: {stats['pagas']} de {stats['empresas']} empresas pagas."
            ),
        )
    except Exception as exc:
        message = str(exc) or "Falha inesperada na apuração."
        timings["total"] = round(time.monotonic() - started, 1)
        try:
            with connection() as db:
                db.execute(
                    "UPDATE apuracao_runs SET status = 'error', finished_at = ?, error = ?, timings = ? WHERE id = ?",
                    (now_iso(), message, json.dumps(timings), run_id),
                )
                db.commit()
        finally:
            _apuracao_job_update(
                running=False, phase="erro", error=message, timings=timings,
                finishedAt=datetime.now().isoformat(timespec="seconds"), message=message,
            )


def apuracao_overview(db, competencia_label, semana=""):
    run = _apuracao_latest_run(db, competencia_label)
    grupos = []
    unmapped_keys = set()
    entries = _apuracao_map_entries(db)
    mapped_keys = {(g, t) for g, t, _ in entries}
    mapped_maes = {mae for _, _, mae in entries}
    week_bounds = {"1": (1, 7), "2": (8, 14), "3": (15, 21), "4": (22, 31)}
    bounds = week_bounds.get(str(semana))
    week_sql = " AND CAST(substr(vencimento, 1, 2) AS INTEGER) BETWEEN ? AND ?" if bounds else ""
    week_params = list(bounds) if bounds else []
    if run:
        rows = db.execute(
            "SELECT grupo_mae, COUNT(DISTINCT documento) AS total, COUNT(DISTINCT CASE WHEN pago = 1 THEN documento END) AS pagas, "
            "ROUND(SUM(valor), 2) AS valor_total, ROUND(SUM(valor_recebido), 2) AS valor_pago "
            f"FROM apuracao_rows WHERE run_id = ?{week_sql} GROUP BY grupo_mae ORDER BY grupo_mae COLLATE NOCASE",
            (run["id"], *week_params),
        ).fetchall()
        faixa_rows = db.execute(
            "SELECT substr(vencimento, 1, 2) AS dia, COUNT(DISTINCT documento) AS total, "
            "COUNT(DISTINCT CASE WHEN pago = 1 THEN documento END) AS pagas "
            f"FROM apuracao_rows WHERE run_id = ? AND grupo_mae = 'SINTEG'{week_sql} "
            "GROUP BY substr(vencimento, 1, 2) ORDER BY dia",
            (run["id"], *week_params),
        ).fetchall()
        faixas = {row["dia"]: [row["total"], row["pagas"]] for row in faixa_rows}
        due_rows = db.execute(
            f"SELECT grupo_mae, vencimento FROM apuracao_rows "
            f"WHERE run_id = ? AND TRIM(vencimento) != ''{week_sql} "
            "GROUP BY grupo_mae, vencimento ORDER BY grupo_mae COLLATE NOCASE, vencimento",
            (run["id"], *week_params),
        ).fetchall()
        vencimentos_por_grupo = {}
        for due_row in due_rows:
            vencimentos_por_grupo.setdefault(due_row["grupo_mae"], []).append(due_row["vencimento"])
        for grupo in rows:
            item = {
                "mae": grupo["grupo_mae"],
                "total": grupo["total"],
                "pagas": grupo["pagas"] or 0,
                "valorTotal": grupo["valor_total"] or 0,
                "valorPago": grupo["valor_pago"] or 0,
                "vencimentos": vencimentos_por_grupo.get(grupo["grupo_mae"], []),
                "novos": grupo["grupo_mae"] not in mapped_maes and grupo["grupo_mae"] != APURACAO_CEARA,
            }
            if item["mae"] == "SINTEG":
                item["faixas"] = [
                    {"faixa": f"Dia {nome}", "total": valores[0], "pagas": valores[1]}
                    for nome, valores in faixas.items()
                ]
            grupos.append(item)
        novos_rows = db.execute(
            "SELECT DISTINCT grupo_empresa, tipo_pagamento FROM apuracao_rows "
            "WHERE run_id = ? AND grupo_empresa != ''",
            (run["id"],),
        ).fetchall()
        for row in novos_rows:
            g, t = _apuracao_norm(row["grupo_empresa"]), _apuracao_norm(row["tipo_pagamento"])
            if (g, t) not in mapped_keys and (g, "") not in mapped_keys:
                unmapped_keys.add(str(row["grupo_empresa"]).strip())
        totals = db.execute(
            f"SELECT COUNT(DISTINCT documento) AS empresas, COUNT(DISTINCT CASE WHEN pago = 1 THEN documento END) AS pagas, "
            f"COUNT(DISTINCT CASE WHEN TRIM(nf) != '' THEN nf END) AS notas "
            f"FROM apuracao_rows WHERE run_id = ?{week_sql}",
            (run["id"], *week_params),
        ).fetchone()
    else:
        totals = None
    return {
        "competencia": competencia_label,
        "competencias": apuracao_competencia_options(),
        "run": {
            "id": run["id"], "status": run["status"], "mode": run["mode"],
            "startedAt": run["started_at"], "finishedAt": run["finished_at"],
            "totalEmpresas": totals["empresas"] if totals else 0, "pagas": totals["pagas"] if totals else 0,
            "totalNotas": totals["notas"] if totals else 0,
            "error": run["error"], "hasFile": bool(run["file_path"]),
            "createdBy": run["created_by"], "timings": _apuracao_timings(run["timings"]),
        } if run else None,
        "grupos": grupos,
        "unmapped": sorted(unmapped_keys),
        "job": apuracao_job_status(),
        "semana": str(semana or ""),
        "canManage": True,
    }


def rateio_number(value):
    try:
        return float(str(value or "0").replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def rateio_date_text(value):
    try:
        return datetime.strptime(str(value or ""), "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return ""


def rateio_life_date(value):
    text = str(value or "").strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def rateio_lives_context(db, competencia_label, parcela):
    overview = rateio_overview(db, competencia_label)
    item = next((entry for entry in overview["items"] if str(entry.get("parcela") or "") == parcela), None)
    if not item:
        raise ValueError("Parcela não encontrada na apuração desta competência.")
    code_match = re.match(r"^\s*(\d+)\s*-", str(item.get("empresa") or ""))
    if not code_match:
        raise ValueError("A empresa desta parcela não possui código para consultar as vidas no S4E.")
    latest_import = db.execute(
        "SELECT * FROM vidas_importacoes WHERE origem = 's4e' ORDER BY importado_em DESC LIMIT 1"
    ).fetchone()
    cancelled = []
    if latest_import:
        cancelled = [dict(row) for row in db.execute(
            "SELECT nome, cpf, contrato, empresa, data, valor, parentesco, situacao, responsavel "
            "FROM vidas_usuarios WHERE import_id = ? AND situacao = 'CANCELADO' ORDER BY data, nome COLLATE NOCASE",
            (latest_import["id"],),
        )]
    return {
        "item": item,
        "companyCode": code_match.group(1),
        "generated": rateio_date_text(item.get("gerado")),
        "cancelled": cancelled,
        "import": dict(latest_import) if latest_import else None,
    }


def rateio_lives_payload(context, active):
    item = context["item"]
    generated = context["generated"]
    company_name = next((row.get("empresa") for row in active if row.get("empresa")), "")
    company_key = vidas._norm(company_name or re.sub(r"^\s*\d+\s*-\s*", "", item["empresa"]))
    included, later = [], []
    for row in active:
        joined = rateio_life_date(row.get("adesao"))
        record = {
            "nome": row.get("nome") or "",
            "titular": row.get("titular") or "",
            "cpf": row.get("cpf") or "",
            "associado": row.get("associado") or "",
            "matricula": row.get("matricula") or "",
            "grupo": row.get("grupo") or "",
            "valor": row.get("valor") or 0,
            "adesao": joined,
            "cancelamento": "",
            "situacao": row.get("situacao") or "ATIVO",
            "motivo": "Ativa na data de geração da parcela",
        }
        if generated and joined and joined > generated:
            record["motivo"] = "Incluída depois da geração da parcela"
            later.append(record)
        else:
            included.append(record)
    for row in context["cancelled"]:
        if vidas._norm(row.get("empresa")) != company_key:
            continue
        cancelled_at = rateio_life_date(row.get("data"))
        if generated and cancelled_at and cancelled_at > generated:
            included.append({
                "nome": row.get("nome") or "",
                "titular": row.get("responsavel") or "",
                "cpf": row.get("cpf") or "",
                "associado": row.get("contrato") or "",
                "matricula": "",
                "grupo": "",
                "valor": row.get("valor") or 0,
                "adesao": "",
                "cancelamento": cancelled_at,
                "situacao": "CANCELADO",
                "motivo": "Cancelada depois da geração; compôs esta parcela",
            })
    included.sort(key=lambda row: str(row["nome"]).casefold())
    later.sort(key=lambda row: str(row["nome"]).casefold())
    expected = item.get("vidasFaturadas") or 0
    expected_int = int(round(float(expected)))
    reconciled = abs(float(expected) - expected_int) < 0.000001 and len(included) == expected_int
    current_unique = len(active)
    reported_current = int(round(float(item.get("vidas") or 0)))
    duplicate_count = max(0, reported_current - current_unique)
    source_import = context.get("import") or {}
    message = (
        f"Conferido: as {len(included)} vidas nominais fecham com a parcela."
        if reconciled else
        f"A lista nominal encontrou {len(included)} de {expected_int} vidas faturadas. Atualize o relatório de usuários antes de concluir a conferência."
    )
    if duplicate_count:
        message += f" O S4E informou {reported_current} vidas atuais, mas há {current_unique} associados únicos; {duplicate_count} linha(s) duplicada(s) foram ignoradas."
    return {
        "empresa": item["empresa"],
        "documento": item["documento"],
        "parcela": item["parcela"],
        "gerado": item["gerado"],
        "vidasS4e": item["vidas"],
        "vidasFaturadas": expected,
        "identificadas": len(included),
        "reconciliado": reconciled,
        "vidasAtuaisUnicas": current_unique,
        "duplicatasIgnoradas": duplicate_count,
        "temDuplicidade": bool(duplicate_count),
        "mensagem": message,
        "fonteCancelamentos": source_import.get("arquivo") or "Nenhum relatório de cancelamentos disponível",
        "incluidas": included,
        "posteriores": later,
    }


def _receipt_number(value):
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return float(text.replace(".", "").replace(",", "."))
    except ValueError:
        return 0.0


def _receipt_company(value):
    return str(value or "").split(" - ", 1)[0].strip()


def _receipt_month(value):
    iso = rateio_date_text(value)
    return iso[:7] if iso else ""


def _receipt_label_month(label):
    window = apuracao_fetch_window(label)
    if not window:
        return ""
    day, month, year = window[0].split("/")
    return f"{year}-{month}"


def _receipt_line(line, metadata):
    paid = round(_receipt_number(line.get("paid")), 2)
    client = str(line.get("client") or "").strip()
    return {
        "chave": [str(line.get("ourNumber") or ""), str(line.get("installment") or ""),
                  str(line.get("dueDate") or ""), str(line.get("paymentDate") or "")],
        "empresa": _receipt_company(client),
        "cliente": client,
        "vencimento": str(line.get("dueDate") or "").strip(),
        "pagamento": str(line.get("paymentDate") or "").strip(),
        "valor": paid,
        "ocorrencia": str(line.get("occurrence") or "").strip(),
        "ocorrenciaCodigo": str(line.get("occurrenceCode") or "").strip(),
        "arquivo": str(metadata.get("filename") or "").strip(),
        "tipo": str(metadata.get("type") or "").strip(),
        "processado": str(metadata.get("processedAt") or "").strip(),
    }


def _receipt_duplicate(entry):
    return (entry["chave"][0], entry["chave"][1], entry["chave"][3], entry["valor"])


def rateio_bank_entries(db):
    """Pagamentos únicos do retorno bancário e ocorrências ainda sem baixa."""
    files = db.execute("SELECT metadata, details FROM retornos_files WHERE details IS NOT NULL ORDER BY checked_at").fetchall()
    paid, pending, types, stamps = {}, {}, set(), []
    for file in files:
        metadata = json.loads(file["metadata"])
        if retornos.source.normalized(metadata.get("status")) == "rejeitado":
            continue
        label = str(metadata.get("type") or "").strip()
        if label:
            types.add(label)
        stamp = str(metadata.get("processedAt") or "").strip()
        if stamp:
            stamps.append(stamp)
        details = json.loads(file["details"])
        for line in details.get("rows") or []:
            entry = _receipt_line(line, metadata)
            if entry["valor"] <= 0:
                continue
            if line.get("severity") == "success":
                paid.setdefault(_receipt_duplicate(entry), entry)
            else:
                pending.setdefault(_receipt_duplicate(entry), entry)
    confirmed = {(key[0], key[1], key[2]) for key in paid}
    pending = {
        key: entry for key, entry in pending.items()
        if (entry["chave"][0], entry["chave"][1], entry["chave"][3]) not in confirmed
    }
    coverage = (len(stamps), min(stamps), max(stamps)) if stamps else (0, "", "")
    return list(paid.values()), list(pending.values()), sorted(types), coverage


def _receipt_bucket(key, label, hint, sign=1):
    return {"key": key, "label": label, "hint": hint, "sign": sign,
            "count": 0, "valor": 0.0, "itens": [], "motivos": {}}


def _receipt_sample(entry, motivo):
    return {"empresa": entry["empresa"] or entry["cliente"], "vencimento": entry["vencimento"],
            "pagamento": entry["pagamento"], "valor": entry["valor"], "tipo": entry["tipo"],
            "arquivo": entry["arquivo"], "motivo": motivo}


def rateio_receipts(db, competencia_label, rows):
    """Concilia o retorno bancário do mês com o relatório analítico da apuração."""
    month = _receipt_label_month(competencia_label)
    paid, pending, types, coverage = rateio_bank_entries(db)
    entries = [entry for entry in paid if _receipt_month(entry["pagamento"]) == month]
    pending_month = [entry for entry in pending if _receipt_month(entry["pagamento"]) == month]
    index, companies = {}, {}
    for row in rows:
        company = _receipt_company(row["empresa"])
        companies.setdefault(company, []).append(row)
        index.setdefault((company, str(row["vencimento"] or "").strip()), []).append(row)
    pending_index = {}
    for entry in pending:
        pending_index.setdefault((entry["empresa"], entry["vencimento"]), entry)

    def received(row):
        return round(float(row["valor_recebido"] or 0), 2)

    buckets = {
        "sem-titulo": _receipt_bucket("sem-titulo", "Recebido no banco sem título na apuração",
                                      "O pagamento existe, mas não há título desta competência para receber."),
        "nao-baixado": _receipt_bucket("nao-baixado", "Banco recebeu e o S4E ainda não baixou",
                                       "O título existe na apuração, porém segue em aberto no relatório."),
        "divergente": _receipt_bucket("divergente", "Valor do banco difere do relatório",
                                      "O título foi localizado, mas o valor pago no banco é diferente do recebido no S4E."),
        "sem-retorno": _receipt_bucket("sem-retorno", "Recebido no relatório sem retorno bancário",
                                       "O S4E registra recebimento, mas não há pagamento correspondente no retorno do período.",
                                       sign=-1),
    }
    used = set()
    used_received = {}
    by_row = {}
    bank_total = 0.0
    conciliado = {"count": 0, "valorBanco": 0.0, "valorRelatorio": 0.0}
    for entry in sorted(entries, key=lambda item: -item["valor"]):
        bank_total += entry["valor"]
        candidates = [row for row in index.get((entry["empresa"], entry["vencimento"]), []) if row["id"] not in used]
        chosen = next((row for row in candidates if received(row) > 0.005 and abs(received(row) - entry["valor"]) <= 0.02), None)
        if chosen is None:
            chosen = next((row for row in candidates if received(row) <= 0.005), None)
        if chosen is None and candidates:
            chosen = min(candidates, key=lambda row: abs(received(row) - entry["valor"]))
        if chosen is None:
            # Cobrança agrupada pode mudar o vencimento: casa pelo valor dentro da empresa.
            company_candidates = [row for row in companies.get(entry["empresa"], [])
                                  if row["id"] not in used and received(row) > 0.005
                                  and abs(received(row) - entry["valor"]) <= 0.02]
            if len(company_candidates) == 1:
                chosen = company_candidates[0]
        if chosen is None:
            key_rows = index.get((entry["empresa"], entry["vencimento"]), [])
            if key_rows:
                motivo = "Título já conciliado por outro pagamento"
            elif entry["empresa"] not in companies:
                motivo = "Empresa fora da apuração"
            else:
                motivo = "Vencimento fora da janela do relatório"
            if (entry["empresa"], entry["vencimento"]) in pending_index:
                motivo = "Ocorrência sem baixa no retorno"
            bucket = buckets["sem-titulo"]
            bucket["count"] += 1
            bucket["valor"] += entry["valor"]
            bucket["motivos"][motivo] = bucket["motivos"].get(motivo, 0) + 1
            if len(bucket["itens"]) < 40:
                bucket["itens"].append(_receipt_sample(entry, motivo))
            continue
        used.add(chosen["id"])
        used_received[chosen["id"]] = received(chosen)
        if received(chosen) > 0.005 and abs(received(chosen) - entry["valor"]) <= 0.02:
            status = "conciliado"
            conciliado["count"] += 1
            conciliado["valorBanco"] += entry["valor"]
            conciliado["valorRelatorio"] += received(chosen)
        elif received(chosen) <= 0.005:
            status = "nao-baixado"
            bucket = buckets["nao-baixado"]
            bucket["count"] += 1
            bucket["valor"] += entry["valor"]
            motivo = "Título em aberto no relatório"
            bucket["motivos"][motivo] = bucket["motivos"].get(motivo, 0) + 1
            if len(bucket["itens"]) < 40:
                bucket["itens"].append(_receipt_sample(entry, motivo))
        else:
            status = "divergente"
            bucket = buckets["divergente"]
            bucket["count"] += 1
            bucket["valor"] += entry["valor"] - received(chosen)
            motivo = f"Banco {entry['valor']:.2f} x relatório {received(chosen):.2f}"
            if len(bucket["itens"]) < 40:
                bucket["itens"].append(_receipt_sample(entry, motivo))
        by_row[chosen["id"]] = {
            "valor": entry["valor"],
            "pagamento": entry["pagamento"],
            "vencimento": entry["vencimento"],
            "ocorrencia": entry["ocorrencia"],
            "ocorrenciaCodigo": entry["ocorrenciaCodigo"],
            "arquivo": entry["arquivo"],
            "tipo": entry["tipo"],
            "situacao": status,
            "diferenca": round(entry["valor"] - received(chosen), 2),
        }

    analytic_total = 0.0
    analytic_count = 0
    for row in rows:
        if row["id"] in used_received:
            analytic_total += used_received[row["id"]]
            if used_received[row["id"]] > 0.005:
                analytic_count += 1
            continue
        if received(row) <= 0.005:
            continue
        payment_month = _receipt_month(row["data_pagamento"])
        credit_month = _receipt_month(row["data_credito"])
        if payment_month != month and credit_month != month:
            continue
        analytic_total += received(row)
        analytic_count += 1
        motivo = ("Ocorrência sem baixa no retorno"
                  if (_receipt_company(row["empresa"]), str(row["vencimento"] or "").strip()) in pending_index
                  else ("Pagamento registrado fora do mês do retorno"
                        if payment_month and payment_month != month
                        else "Sem retorno bancário no período"))
        bucket = buckets["sem-retorno"]
        bucket["count"] += 1
        bucket["valor"] -= received(row)
        bucket["motivos"][motivo] = bucket["motivos"].get(motivo, 0) + 1
        if len(bucket["itens"]) < 40:
            bucket["itens"].append({
                "empresa": str(row["empresa"] or "").strip(),
                "vencimento": str(row["vencimento"] or "").strip(),
                "pagamento": str(row["data_pagamento"] or "").strip(),
                "credito": str(row["data_credito"] or "").strip(),
                "valor": received(row),
                "motivo": motivo,
            })

    groups = []
    for bucket in buckets.values():
        if not bucket["count"]:
            continue
        groups.append({
            "key": bucket["key"], "label": bucket["label"], "hint": bucket["hint"], "sign": bucket["sign"],
            "count": bucket["count"], "valor": round(bucket["valor"], 2),
            "itens": bucket["itens"],
            "motivos": [{"label": label, "count": count} for label, count in sorted(bucket["motivos"].items(), key=lambda item: -item[1])],
        })
    pending_items = [_receipt_sample(entry, entry["ocorrencia"]) for entry in pending_month[:40]]
    return {
        "mes": month,
        "temRetorno": bool(paid),
        "cobertura": {
            "arquivos": coverage[0],
            "de": coverage[1],
            "ate": coverage[2],
            "tipos": types,
        },
        "banco": {"count": len(entries), "valor": round(bank_total, 2)},
        "relatorio": {"count": analytic_count, "valor": round(analytic_total, 2)},
        "diferenca": round(bank_total - analytic_total, 2),
        "status": "ok" if abs(bank_total - analytic_total) <= 0.05 else ("divergente" if entries or analytic_count else "sem-retorno"),
        "conciliado": {
            "count": conciliado["count"],
            "valorBanco": round(conciliado["valorBanco"], 2),
            "valorRelatorio": round(conciliado["valorRelatorio"], 2),
        },
        "grupos": groups,
        "ocorrencias": {
            "count": len(pending_month),
            "valor": round(sum(entry["valor"] for entry in pending_month), 2),
            "itens": pending_items,
        },
    }, by_row


def rateio_overview(db, competencia_label, filters=None):
    filters = filters or {}
    run = _apuracao_latest_run(db, competencia_label)
    all_rules = db.execute("SELECT * FROM rateio_rules ORDER BY grupo, empresa, recebedor").fetchall()
    rules = [r for r in all_rules if r["ativo"]]
    payload_rules = [{"id": r["id"], "grupo": r["grupo"], "grupoEmpresa": r["grupo_empresa"], "empresa": r["empresa"], "recebedor": r["recebedor"], "metodo": r["metodo"], "valor": r["valor"], "ativo": bool(r["ativo"]), "vigenciaInicio": r["vigencia_inicio"], "vigenciaFim": r["vigencia_fim"]} for r in all_rules]
    if not run:
        return {"competencia": competencia_label, "competencias": apuracao_competencia_options(), "run": None, "rules": payload_rules, "items": [], "recebedores": [], "alerts": [], "receipts": None}
    rows = db.execute("SELECT * FROM apuracao_rows WHERE run_id = ? ORDER BY grupo_mae, empresa", (run["id"],)).fetchall()
    receipts, receipt_rows = rateio_receipts(db, competencia_label, rows)
    parcel_types = sorted({str(row["tipo_parcela"] or "").strip() for row in rows if str(row["tipo_parcela"] or "").strip()})
    items, totals, alerts = [], {}, []
    for row in rows:
        if filters.get("tipoParcela") and row["tipo_parcela"] != filters["tipoParcela"]: continue
        if filters.get("pagamentoStatus") == "pagos" and not row["pago"]: continue
        if filters.get("pagamentoStatus") == "pendentes" and row["pago"]: continue
        vencimento_iso, pagamento_iso = rateio_date_text(row["vencimento"]), rateio_date_text(row["data_pagamento"])
        credito_iso = rateio_date_text(row["data_credito"])
        if filters.get("vencimentoDe") and vencimento_iso < filters["vencimentoDe"]: continue
        if filters.get("vencimentoAte") and vencimento_iso > filters["vencimentoAte"]: continue
        if filters.get("pagamentoDe") and pagamento_iso < filters["pagamentoDe"]: continue
        if filters.get("pagamentoAte") and pagamento_iso > filters["pagamentoAte"]: continue
        if filters.get("creditoDe") and credito_iso < filters["creditoDe"]: continue
        if filters.get("creditoAte") and credito_iso > filters["creditoAte"]: continue
        group = str(row["grupo_mae"] or row["grupo_empresa"] or "").strip()
        company = str(row["empresa"] or "").strip()
        group_company = str(row["grupo_empresa"] or "").strip()
        if filters.get("grupo") and group != filters["grupo"]: continue
        if filters.get("grupoEmpresa") and group_company != filters["grupoEmpresa"]: continue
        if filters.get("empresa") and company != filters["empresa"]: continue
        vidas, faturado = rateio_number(row["vidas"]), float(row["valor"] or 0)
        applicable = [
            r for r in rules
            if r["grupo"] == group
            and (not r["grupo_empresa"] or r["grupo_empresa"] == group_company)
            and (not r["empresa"] or r["empresa"] == company)
        ]
        company_rules = [r for r in applicable if r["empresa"] == company]
        if company_rules:
            applicable = company_rules
        # O campo de vidas do S4E nem sempre representa as vidas efetivamente
        # cobradas. A planilha financeira calcula a quantidade pela parcela:
        # valor base / soma das regras por vida. Isso evita inflar o rateio
        # quando o cadastro do título traz mais vidas do que as faturadas.
        per_life_total = sum(float(r["valor"] or 0) for r in applicable if r["metodo"] == "por_vida")
        billed_lives = faturado / per_life_total if per_life_total > 0 else vidas
        if abs(billed_lives - round(billed_lives)) < 0.000001:
            billed_lives = int(round(billed_lives))
        else:
            billed_lives = round(billed_lives, 4)
        allocations = []
        for rule in applicable:
            amount = faturado * float(rule["valor"] or 0) / 100 if rule["metodo"] == "percentual" else (billed_lives * float(rule["valor"] or 0) if rule["metodo"] == "por_vida" else float(rule["valor"] or 0))
            amount = round(amount, 2)
            allocations.append({"recebedor": rule["recebedor"], "valor": amount})
            totals[rule["recebedor"]] = round(totals.get(rule["recebedor"], 0) + amount, 2)
        total_rateado = round(sum(x["valor"] for x in allocations), 2)
        if not applicable:
            alerts.append(f"{group or 'Sem grupo'}: sem regra")
        elif total_rateado > faturado + 0.01:
            alerts.append(f"{company}: rateio maior que o faturamento")
        received = float(row["valor_recebido"] or 0)
        items.append({"empresa": company, "grupo": group, "grupoEmpresa": row["grupo_empresa"], "documento": row["documento"], "vidas": vidas, "vidasFaturadas": billed_lives, "faturado": faturado, "titulo": row["titulo"], "imposto": row["imposto"], "multa": row["multa"], "acrescimo": row["acrescimo"], "acrescimoAvulso": row["acrescimo_avulso"], "desconto": row["desconto"], "descontoPagamento": row["desconto_pagamento"], "tarifa": row["tarifa"], "taxa": row["taxa"], "valorRecebido": received, "diferencaRecebimento": round(received - faturado, 2), "vencimento": row["vencimento"], "pagamento": row["data_pagamento"], "credito": row["data_credito"], "competenciaOriginal": row["competencia"], "empresaS4e": row["empresa_s4e"], "departamento": row["departamento"], "situacao": row["situacao"], "gerado": row["gerado"], "tipoParcela": row["tipo_parcela"], "tipoRecebimento": row["tipo_recebimento"], "tipoPagamento": row["tipo_pagamento"], "parcela": row["parcela"], "nf": row["nf"], "nfLote": row["nf_lote"], "emissao": row["emissao"], "vlPlano": row["vl_plano"], "vlOrto": row["vl_orto"], "vlProRata": row["vl_prorata"], "vendedor": row["vendedor"], "banco": receipt_rows.get(row["id"]), "rateios": allocations, "totalRateado": total_rateado, "saldo": round(faturado - total_rateado, 2)})
    return {"competencia": competencia_label, "competencias": apuracao_competencia_options(), "run": {"id": run["id"], "finishedAt": run["finished_at"]}, "rules": payload_rules, "items": items, "tiposParcela": parcel_types, "recebedores": [{"nome": k, "valor": v} for k, v in sorted(totals.items())], "alerts": sorted(set(alerts)), "receipts": receipts}


def rateio_build_xlsx(data):
    money = xlsx_simple.Money
    items = data.get("items") or []
    billing = sum(x["faturado"] for x in items)
    allocated = sum(x["totalRateado"] for x in items)
    received = sum(x["valorRecebido"] for x in items)
    receipts = data.get("receipts") or {}
    summary = [["Competência", data.get("competencia", "")], ["Faturamento base", money(billing)], ["Valor recebido", money(received)], ["Total rateado base", money(allocated)], ["Saldo do rateio base", money(billing - allocated)], ["Diferença recebida (juros/multas/descontos)", money(received - billing)]]
    if receipts.get("banco"):
        summary.extend([
            ["Recebido no banco (retorno)", money(receipts["banco"].get("valor", 0))],
            ["Relatório analítico", money((receipts.get("relatorio") or {}).get("valor", 0))],
            ["Diferença banco x relatório", money(receipts.get("diferenca", 0))],
        ])
        for group in receipts.get("grupos") or []:
            summary.append([group["label"], f'{money(group["valor"])} ({group["count"]})'])
    receivers = [["Conta", "Valor a receber"]] + [[x["nome"], money(x["valor"])] for x in data.get("recebedores") or []]
    details = [["Centro de custo", "Grupo", "Empresa", "CNPJ", "Vencimento", "Pagamento", "Crédito", "Competência original", "Vidas S4E", "Vidas faturadas", "Nº parcela", "Valor parcela", "Acréscimo parcela", "Imposto", "Título", "Taxa", "Multa", "Acréscimo avulso", "Desconto parcela", "Desconto pagamento", "Tarifa", "Valor recebido", "Pago no banco", "Conferência", "Diferença recebida", "NF", "Rateado base", "Saldo base", "Distribuição"]]
    conferencia_label = {"conciliado": "Conciliado", "nao-baixado": "S4E em aberto", "divergente": "Valor divergente"}
    for x in items:
        banco = x.get("banco") or {}
        details.append([x["grupo"], x["grupoEmpresa"], x["empresa"], x["documento"], x["vencimento"], x["pagamento"], x["credito"], x["competenciaOriginal"], x["vidas"], x["vidasFaturadas"], x["parcela"], money(x["faturado"]), money(x["acrescimo"]), money(x["imposto"]), money(x["titulo"]), money(x["taxa"]), money(x["multa"]), money(x["acrescimoAvulso"]), money(x["desconto"]), money(x["descontoPagamento"]), money(x["tarifa"]), money(x["valorRecebido"]), money(banco.get("valor", 0)) if banco else "", conferencia_label.get(banco.get("situacao"), "Sem retorno" if x["valorRecebido"] else "Em aberto"), money(x["diferencaRecebimento"]), x["nf"], money(x["totalRateado"]), money(x["saldo"]), "; ".join(f'{r["recebedor"]}: {r["valor"]:.2f}' for r in x["rateios"])])
    rules = [["Centro de custo", "Grupo", "Empresa (exceção)", "Conta", "Método", "Valor"]]
    for r in data.get("rules") or []:
        rules.append([r["grupo"], r.get("grupoEmpresa") or "", r["empresa"], r["recebedor"], r["metodo"], r["valor"]])
    return xlsx_simple.build([("Resumo", summary), ("Por conta", receivers), ("Lançamentos", details), ("Regras", rules)])


def apuracao_sheet_xml(headers, rows, kinds):
    def cell_xml(reference, kind, value, row_index):
        if kind == "money":
            return finance_cell_xml(reference, round(float(value or 0), 2), 1)
        if kind == "date":
            raw = str(value or "")
            if re.fullmatch(r"\d{2}/\d{2}/\d{4}", raw):
                raw = f"{raw[6:]}-{raw[3:5]}-{raw[:2]}"
            serial = finance_date_serial(raw)
            return finance_cell_xml(reference, serial, 2) if serial is not None else ""
        if kind == "int":
            return finance_cell_xml(reference, int(value or 0))
        if kind == "formula":
            formula = str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            cached = "PAGO" if rows[row_index - 2][8] else ""
            return f'<c r="{reference}" t="str"><f>{formula}</f><v>{cached}</v></c>'
        return finance_cell_xml(reference, value)

    rows_xml = [
        '<row r="1">' + "".join(
            finance_cell_xml(f"{finance_column_letter(index)}1", header)
            for index, header in enumerate(headers)
        ) + "</row>"
    ]
    for row_index, values in enumerate(rows, start=2):
        cells = []
        for col_index, kind in enumerate(kinds):
            reference = f"{finance_column_letter(col_index)}{row_index}"
            value = values[col_index] if col_index < len(values) else ""
            if kind == "formula":
                value = str(value).format(row=row_index)
            cells.append(cell_xml(reference, kind, value, row_index))
        rows_xml.append(f'<row r="{row_index}">' + "".join(cells) + "</row>")
    last_reference = f"{finance_column_letter(max(0, len(headers) - 1))}{len(rows) + 1}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{XLSX_NS[1:-1]}">'
        f'<dimension ref="A1:{last_reference}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        "</sheetView></sheetViews>"
        "<sheetData>" + "".join(rows_xml) + "</sheetData></worksheet>"
    )


def apuracao_xlsx_safe_name(name):
    text = re.sub(r"[\\/*?:\[\]\x00-\x1f\ud800-\udfff\ufffe\uffff]", "-", str(name or "").strip())
    return text.strip("'")[:31].strip("'") or "Grupo"


def apuracao_build_xlsx(resumo, grupos):
    sheet_xmls = []
    sheet_names = []
    resumo_headers = ("Grupo", "Total de empresas", "Pagas", "% pago", "Valor total", "Valor pago")
    resumo_kinds = ("text", "int", "int", "int", "money", "money")
    resumo_rows = []
    for item in resumo:
        pct = round(100 * item["pagas"] / item["total"]) if item["total"] else 0
        resumo_rows.append([item["mae"], item["total"], item["pagas"], pct, item["valorTotal"], item["valorPago"]])
    sheet_xmls.append(apuracao_sheet_xml(resumo_headers, resumo_rows, resumo_kinds))
    sheet_names.append("Resumo")
    detalhe_headers = (
        "Código", "EMPRESA", "CNPJ", "Vidas", "Vencimento", "NF",
        "Valor da mensalidade", "Valor recebido", "Dt. pagamento (crédito)", "Situação", "Grupo", "Tipo de pagamento",
    )
    detalhe_kinds = ("text", "text", "text", "int", "date", "text", "money", "money", "date", "formula", "text", "text")
    for mae in sorted(grupos, key=lambda nome: nome.upper()):
        rows = grupos[mae]
        detalhe_rows = []
        for row in rows:
            codigo, _, nome = str(row["empresa"] or "").partition(" - ")
            if not nome:
                codigo, nome = "", codigo
            detalhe_rows.append([
                codigo.strip(), nome.strip() or str(row["empresa"] or ""), row["documento"],
                int(float(str(row["vidas"] or "0") or 0)), row["vencimento"], row.get("nf") or "",
                row["valor"], row["valor_recebido"], row["data_pagamento"],
                'IF(I{row}>1,"PAGO","")', row.get("grupo_empresa", ""), row.get("tipo_pagamento", ""),
            ])
        sheet_xmls.append(apuracao_sheet_xml(detalhe_headers, detalhe_rows, detalhe_kinds))
        base_name = apuracao_xlsx_safe_name(mae)
        sheet_name = base_name
        suffix_number = 2
        while sheet_name.casefold() in {name.casefold() for name in sheet_names}:
            suffix = f" ({suffix_number})"
            sheet_name = base_name[:31 - len(suffix)].rstrip("'") + suffix
            suffix_number += 1
        sheet_names.append(sheet_name)
    sheet_count = len(sheet_xmls)
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + "".join(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, sheet_count + 1)
        )
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook_sheets = "".join(
        ET.tostring(ET.Element("sheet", {
            "name": sheet_names[index - 1], "sheetId": str(index), "r:id": f"rId{index}",
        }), encoding="unicode")
        for index in range(1, sheet_count + 1)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{XLSX_NS[1:-1]}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{workbook_sheets}</sheets></workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
            for index in range(1, sheet_count + 1)
        )
        + f'<Relationship Id="rId{sheet_count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{XLSX_NS[1:-1]}">'
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", root_rels)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        package.writestr("xl/styles.xml", styles_xml)
        for index, sheet_xml in enumerate(sheet_xmls, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", sheet_xml)
    return buffer.getvalue()


def apuracao_gerar_planilha(run_id):
    with connection() as db:
        run = db.execute("SELECT * FROM apuracao_runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise ValueError("Apuração não encontrada.")
        rows = db.execute(
            "SELECT * FROM apuracao_rows WHERE run_id = ? ORDER BY grupo_mae COLLATE NOCASE, empresa COLLATE NOCASE",
            (run_id,),
        ).fetchall()
    grupos = {}
    for row in rows:
        grupos.setdefault(row["grupo_mae"], []).append(dict(row))
    resumo = [
        {
            "mae": mae,
            "total": len({item["documento"] for item in items}),
            "pagas": len({item["documento"] for item in items if item["pago"]}),
            "valorTotal": round(sum(item["valor"] for item in items), 2),
            "valorPago": round(sum(item["valor_recebido"] for item in items), 2),
        }
        for mae, items in sorted(grupos.items(), key=lambda pair: pair[0].upper())
    ]
    data = apuracao_build_xlsx(resumo, grupos)
    hoje = datetime.now(timezone(timedelta(hours=-3))).date()
    semana = (hoje.day - 1) // 7 + 1
    pasta = APURACAO_DIR / f"{hoje.year:04d}" / f"{hoje.month:02d}" / f"semana_{semana}"
    nome = "apuracao_" + re.sub(r"[^A-Za-z0-9]+", "_", run["competencia_label"] or "competencia") + f"_{uuid.UUID(str(run_id))}.xlsx"
    destino = (pasta / nome).resolve()
    destino.relative_to(APURACAO_DIR.resolve())
    pasta.mkdir(parents=True, exist_ok=True)
    with destino.open("xb") as arquivo:
        arquivo.write(data)
    return destino


def apuracao_relatorio_xlsx(run_id, report_type, week="", group=""):
    titles = {
        "notas": "notas_fiscais",
        "sem_pagamento": "empresas_sem_pagamento",
        "pagas": "empresas_pagas",
        "semanal": "relatorio_semanal",
        "grupo": "relatorio_por_grupo",
        "consolidado": "consolidado_competencia_grupo_empresa",
    }
    if report_type not in titles:
        raise ValueError("Tipo de relatório inválido.")
    bounds = {"1": (1, 7), "2": (8, 14), "3": (15, 21), "4": (22, 31)}.get(str(week))
    with connection() as db:
        run = db.execute("SELECT competencia_label FROM apuracao_runs WHERE id = ? AND status = 'done'", (run_id,)).fetchone()
        if not run:
            raise ValueError("Apuração concluída não encontrada.")
        rows = [dict(row) for row in db.execute(
            "SELECT empresa, documento, grupo_mae, vencimento, nf, competencia, data_pagamento, pago, valor, valor_recebido "
            "FROM apuracao_rows WHERE run_id = ? ORDER BY grupo_mae COLLATE NOCASE, empresa COLLATE NOCASE",
            (run_id,),
        ).fetchall()]
    if bounds:
        rows = [row for row in rows if bounds[0] <= int(str(row["vencimento"] or "0").split("/")[0] or 0) <= bounds[1]]
    if report_type == "notas":
        rows = [
            row for row in rows
            if str(row["nf"] or "").strip().lower() not in {"", "-", "—", "não informada", "nao informada"}
        ]
    elif report_type == "sem_pagamento":
        rows = [row for row in rows if not row["pago"]]
    elif report_type == "pagas":
        rows = [row for row in rows if row["pago"]]
    if report_type == "grupo":
        if not group:
            raise ValueError("Clique no grupo desejado antes de exportar este relatório.")
        rows = [row for row in rows if row["grupo_mae"] == group]
    headers = ("Empresa", "CNPJ", "Grupo", "Vencimento", "Nota fiscal", "Competência", "Semana", "Data do pagamento", "Situação", "Valor", "Valor recebido")
    values = []
    for row in rows:
        day = int(str(row["vencimento"] or "0").split("/")[0] or 0)
        row_week = 1 if day <= 7 else 2 if day <= 14 else 3 if day <= 21 else 4
        values.append([
            row["empresa"], row["documento"], row["grupo_mae"], row["vencimento"], row["nf"],
            row["competencia"], f"{row_week}ª", row["data_pagamento"] or "",
            "Pago" if row["pago"] else "Sem pagamento",
            row["valor"], row["valor_recebido"],
        ])
    if not values:
        values.append(["Nenhum registro encontrado", "", "", "", "", "", "", "", 0, 0, 0])
    kinds = ("text", "text", "text", "date", "text", "text", "text", "date", "text", "money", "money")
    data = apuracao_sheet_xml(headers, values, kinds)
    workbook = apuracao_build_xlsx([], {})
    with zipfile.ZipFile(io.BytesIO(workbook), "r") as package:
        files = {name: package.read(name) for name in package.namelist()}
    # Reuse the existing XLSX package structure and replace its first worksheet.
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        for name, content in files.items():
            package.writestr("xl/worksheets/sheet1.xml" if name == "xl/worksheets/sheet1.xml" else name, data if name == "xl/worksheets/sheet1.xml" else content)
    return output.getvalue(), f"{titles[report_type]}_{re.sub(r'[^A-Za-z0-9]+', '_', run['competencia_label'])}.xlsx"


# ── Recibos em PDF (somente empresas que pagaram) ───────────────────────────
RECIBOS_DIR = ROOT / "recibos"
RECIBOS_KEEP_RUNS = 8
RECIBOS_MAX_DAYS = 62
RECIBOS_WORKERS = 6

_recibos_job = {
    "id": None, "running": False, "phase": "", "message": "",
    "percent": 0, "startedAt": None, "finishedAt": None,
    "runId": None, "total": 0, "done": 0, "error": None,
}
_recibos_job_lock = threading.Lock()


def recibos_job_status():
    with _recibos_job_lock:
        return dict(_recibos_job)


def _recibos_job_update(**fields):
    with _recibos_job_lock:
        _recibos_job.update(fields)


def recibos_allowed(db, user):
    if is_manager(user):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_screens WHERE user_id = ? AND screen_id = 'recibosScreen'",
        (user["id"],),
    ).fetchone())


def require_recibos(db, handler):
    user = require_user(db, handler)
    if not user:
        return None
    if not recibos_allowed(db, user):
        handler.send_json({"error": "Você não tem acesso à tela de Recibos."}, 403)
        return None
    return user


_WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _recibos_safe(value, fallback="Sem nome", limit=90):
    text = _WINDOWS_INVALID.sub(" ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:limit] or fallback


def _recibos_day(value):
    raw = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw[:10], fmt).date()
        except ValueError:
            continue
    raise s4e.ConnectorError("Informe a data inicial e a data final do período.")


def _recibos_br(day):
    return day.strftime("%d/%m/%Y")


def _recibos_value(text):
    raw = re.sub(r"[^0-9.,]", "", str(text or ""))
    raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return 0.0


def _recibos_fetch_item(http_session, item):
    last_error = ""
    for _attempt in range(2):
        try:
            fields = s4e.fetch_receipt(http_session, item["parcela"])
            return {"status": "ok", "fields": fields, "error": ""}
        except s4e.ConnectorError as exc:
            last_error = str(exc) or "O S4E não devolveu o recibo."
            if "expirou" in last_error:
                return {"status": "erro", "error": last_error, "expired": True}
            break
        except (TimeoutError, urllib.error.URLError, OSError):
            last_error = "O S4E demorou para devolver este recibo."
    return {"status": "erro", "error": last_error or "Falha ao ler o recibo.", "expired": False}


def _recibos_prune(db, keep=RECIBOS_KEEP_RUNS):
    runs = db.execute(
        "SELECT id, folder, zip_path FROM recibo_runs WHERE status != 'running' ORDER BY started_at DESC"
    ).fetchall()
    for row in runs[keep:]:
        db.execute("DELETE FROM recibo_items WHERE run_id = ?", (row["id"],))
        db.execute("DELETE FROM recibo_runs WHERE id = ?", (row["id"],))
        if row["folder"]:
            shutil.rmtree(row["folder"], ignore_errors=True)
        if row["zip_path"]:
            try:
                Path(row["zip_path"]).unlink()
            except OSError:
                pass


def _recibos_recover_stale(db):
    stale = db.execute(
        "SELECT id, started_at FROM recibo_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    if not stale:
        return
    job = recibos_job_status()
    if job["running"] and job.get("runId") == stale["id"]:
        return
    age = _auto_age_minutes(stale["started_at"])
    if age is not None and age > 25:
        db.execute(
            "UPDATE recibo_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
            (now_iso(), "Geração interrompida. Tente novamente.", stale["id"]),
        )
        db.commit()


def recibos_run_payload(row):
    return {
        "id": row["id"], "periodStart": row["period_start"], "periodEnd": row["period_end"],
        "centroCusto": row["centro_custo"], "grupo": row["grupo"], "status": row["status"],
        "message": row["message"], "total": row["total"], "gerados": row["gerados"],
        "ignorados": row["ignorados"], "erros": row["erros"], "empresas": row["empresas"],
        "hasZip": bool(row["zip_path"]), "createdBy": row["created_by"],
        "startedAt": row["started_at"], "finishedAt": row["finished_at"], "error": row["error"],
    }


def _recibos_last_apuracao(db):
    return db.execute(
        "SELECT id, started_at, finished_at FROM apuracao_runs "
        "WHERE status = 'done' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()


def _recibos_centros(db, ap_run=None):
    """Centro de custo (grupo-mãe da Apuração) → grupos do S4E que ficam dentro dele."""
    tree = {}
    for row in db.execute("SELECT grupo_mae, grupo FROM apuracao_map"):
        centro = str(row["grupo_mae"] or "").strip()
        grupo = str(row["grupo"] or "").strip()
        if not centro:
            continue
        tree.setdefault(centro, set())
        if grupo:
            tree[centro].add(grupo)
    if ap_run:
        for row in db.execute(
            "SELECT DISTINCT grupo_mae, grupo_empresa FROM apuracao_rows WHERE run_id = ?",
            (ap_run["id"],),
        ):
            centro = str(row["grupo_mae"] or "").strip()
            grupo = str(row["grupo_empresa"] or "").strip()
            if not centro:
                continue
            tree.setdefault(centro, set())
            if grupo:
                tree[centro].add(grupo)
    tree.setdefault(APURACAO_CEARA, set())
    return [
        {"nome": nome, "grupos": sorted(grupos, key=str.casefold)}
        for nome, grupos in sorted(tree.items(), key=lambda item: str.casefold(item[0]))
    ]


def recibos_overview(db):
    _recibos_recover_stale(db)
    runs = db.execute(
        "SELECT * FROM recibo_runs ORDER BY started_at DESC LIMIT 10"
    ).fetchall()
    ap_run = _recibos_last_apuracao(db)
    base = None
    if ap_run:
        counts = db.execute(
            "SELECT count(*) AS parcelas, "
            "count(DISTINCT empresa) AS empresas, "
            "sum(CASE WHEN pago = 1 THEN 1 ELSE 0 END) AS pagas "
            "FROM apuracao_rows WHERE run_id = ?",
            (ap_run["id"],),
        ).fetchone()
        base = {
            "runId": ap_run["id"], "startedAt": ap_run["started_at"],
            "finishedAt": ap_run["finished_at"],
            "parcelas": counts["parcelas"] or 0,
            "empresas": counts["empresas"] or 0,
            "pagas": counts["pagas"] or 0,
        }
    return {
        "centros": _recibos_centros(db, ap_run),
        "base": base,
        "runs": [recibos_run_payload(row) for row in runs],
    }


def _recibos_ap_date(value):
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(value or "").strip()[:10], fmt).date()
        except ValueError:
            continue
    return None


def recibos_previa(db, start_day, end_day, centro="", grupo=""):
    """Contagem rápida pela última apuração, sem consultar o S4E."""
    ap_run = _recibos_last_apuracao(db)
    if not ap_run:
        return {
            "base": None,
            "empresas": 0, "parcelas": 0, "valor": 0.0,
            "centros": 0, "grupos": 0, "detalhe": [],
        }
    empresas = set()
    grupos = set()
    centros = set()
    parcelas = 0
    valor = 0.0
    detalhe = {}
    for row in db.execute(
        "SELECT grupo_mae, grupo_empresa, empresa, vencimento, valor_recebido, pago "
        "FROM apuracao_rows WHERE run_id = ?",
        (ap_run["id"],),
    ):
        if not row["pago"]:
            continue
        dia = _recibos_ap_date(row["vencimento"])
        if dia is None or dia < start_day or dia > end_day:
            continue
        if centro and str(row["grupo_mae"] or "").strip() != centro:
            continue
        if grupo and str(row["grupo_empresa"] or "").strip() != grupo:
            continue
        nome_centro = str(row["grupo_mae"] or "").strip() or "Sem centro de custo"
        parcelas += 1
        valor += float(row["valor_recebido"] or 0)
        empresas.add(str(row["empresa"] or "").strip())
        centros.add(nome_centro)
        if str(row["grupo_empresa"] or "").strip():
            grupos.add(str(row["grupo_empresa"]).strip())
        entry = detalhe.setdefault(nome_centro, {"centroCusto": nome_centro, "empresas": set(), "parcelas": 0, "valor": 0.0})
        entry["empresas"].add(str(row["empresa"] or "").strip())
        entry["parcelas"] += 1
        entry["valor"] += float(row["valor_recebido"] or 0)
    return {
        "base": {
            "runId": ap_run["id"], "startedAt": ap_run["started_at"],
            "finishedAt": ap_run["finished_at"],
        },
        "empresas": len([nome for nome in empresas if nome]),
        "parcelas": parcelas,
        "valor": round(valor, 2),
        "centros": len(centros),
        "grupos": len(grupos),
        "detalhe": [
            {
                "centroCusto": item["centroCusto"],
                "empresas": len([nome for nome in item["empresas"] if nome]),
                "parcelas": item["parcelas"],
                "valor": round(item["valor"], 2),
            }
            for item in sorted(detalhe.values(), key=lambda item: (-item["parcelas"], str.casefold(item["centroCusto"])))
        ],
    }


def recibos_items(db, run_id):
    return [
        {
            "parcela": row["parcela"], "empresa": row["empresa"], "documento": row["documento"],
            "centroCusto": row["grupo_mae"], "grupo": row["grupo_empresa"],
            "vencimento": row["vencimento"], "valor": row["valor"],
            "dataCredito": row["data_credito"], "competencia": row["competencia"],
            "status": row["status"], "error": row["error"], "hasPdf": bool(row["path"]),
        }
        for row in db.execute(
            "SELECT * FROM recibo_items WHERE run_id = ? "
            "ORDER BY grupo_mae COLLATE NOCASE, grupo_empresa COLLATE NOCASE, "
            "empresa COLLATE NOCASE, parcela",
            (run_id,),
        )
    ]


def recibos_start_run(period_start, period_end, centro="", grupo="", user_name=""):
    start_day = _recibos_day(period_start)
    end_day = _recibos_day(period_end)
    if end_day < start_day:
        raise s4e.ConnectorError("A data final precisa ser depois da data inicial.")
    if (end_day - start_day).days > RECIBOS_MAX_DAYS:
        raise s4e.ConnectorError(
            f"Escolha um período de até {RECIBOS_MAX_DAYS} dias para não sobrecarregar o S4E."
        )
    centro = str(centro or "").strip()
    grupo = str(grupo or "").strip()
    run_id = str(uuid.uuid4())
    with _auto_start_lock:
        with _recibos_job_lock:
            if _recibos_job["running"]:
                raise s4e.ConnectorError("Já existe uma geração de recibos em andamento. Aguarde terminar.")
        if _s4e_auto_busy():
            raise s4e.ConnectorError("O S4E está ocupado com outra leitura. Tente novamente em alguns minutos.")
        with _recibos_job_lock:
            previous_job = dict(_recibos_job)
            _recibos_job.update(
                id=uuid.uuid4().hex, running=True, phase="inicio",
                message="Preparando a geração dos recibos...", percent=1,
                startedAt=datetime.now().isoformat(timespec="seconds"),
                finishedAt=None, runId=run_id, total=0, done=0, error=None,
            )
        inserted = False
        try:
            with connection() as db:
                if system_lock_state(db)[0]:
                    raise s4e.ConnectorError("O portal está bloqueado pela administração.")
                db.execute(
                    "INSERT INTO recibo_runs(id, period_start, period_end, centro_custo, grupo, "
                    "status, phase, message, created_by, started_at) "
                    "VALUES (?, ?, ?, ?, ?, 'running', 'inicio', ?, ?, ?)",
                    (
                        run_id, start_day.strftime("%Y-%m-%d"), end_day.strftime("%Y-%m-%d"),
                        centro, grupo, "Preparando a geração dos recibos...",
                        user_name, now_iso(),
                    ),
                )
                db.commit()
                inserted = True
            threading.Thread(
                target=_recibos_worker, args=(run_id, start_day, end_day, centro, grupo),
                name="recibos-run", daemon=True,
            ).start()
        except Exception:
            if inserted:
                with connection() as db:
                    db.execute(
                        "UPDATE recibo_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
                        (now_iso(), "Não foi possível iniciar a geração.", run_id),
                    )
                    db.commit()
            with _recibos_job_lock:
                _recibos_job.clear()
                _recibos_job.update(previous_job)
            raise
    return run_id


def _recibos_worker(run_id, start_day, end_day, centro, grupo):
    def progress(percent, phase, message):
        _recibos_job_update(percent=max(0, min(100, percent)), phase=phase, message=message)

    generated = 0
    skipped = 0
    errors = 0
    companies = set()
    session = None
    try:
        session = s4e.ensure_session()
        progress(3, "inicio", "Abrindo o relatório de faturamento no S4E...")

        def report_progress(done, total, message):
            progress(4 + round(26 * done / max(total, 1)), "relatorio", message)

        try:
            rows = s4e.fetch_faturamento_rows(
                session, _recibos_br(start_day), _recibos_br(end_day), report_progress
            )
        except s4e.ConnectorError as exc:
            if "expirou" not in str(exc):
                raise
            s4e.disconnect()
            progress(6, "relatorio", "Sessão do S4E expirada. Entrando novamente com a conta salva...")
            session = s4e.ensure_session()
            rows = s4e.fetch_faturamento_rows(
                session, _recibos_br(start_day), _recibos_br(end_day), report_progress
            )

        progress(31, "filtro", "Selecionando as empresas que pagaram...")
        with connection() as db:
            entries = _apuracao_map_entries(db)

        selected = []
        seen = set()
        for row in rows:
            if not str(row.get("dataCredito") or "").strip():
                continue
            parcela = re.sub(r"\D", "", str(row.get("parcela") or ""))
            if not parcela or parcela in seen:
                continue
            mae = apuracao_resolve_mae(entries, row.get("grupo") or "", row.get("tipoPagamento") or "")
            if centro and mae != centro:
                continue
            if grupo and str(row.get("grupo") or "").strip() != grupo:
                continue
            seen.add(parcela)
            selected.append({
                "parcela": parcela,
                "empresa": row.get("cliente") or "",
                "documento": row.get("documento") or "",
                "centro": mae,
                "grupo": str(row.get("grupo") or "").strip(),
                "vencimento": row.get("vencimento") or "",
                "valor": float(row.get("valorRecebido") or row.get("valor") or 0),
                "dataCredito": row.get("dataCredito") or "",
                "competencia": row.get("competencia") or "",
                "tipoParcela": row.get("tipoParcela") or "",
            })

        total = len(selected)
        with connection() as db:
            db.execute("UPDATE recibo_runs SET total = ?, phase = 'filtro' WHERE id = ?", (total, run_id))
            db.commit()

        if not total:
            message = "Nenhuma empresa paga foi encontrada para o período e os filtros escolhidos."
            with connection() as db:
                db.execute(
                    "UPDATE recibo_runs SET status = 'done', phase = 'fim', message = ?, finished_at = ? WHERE id = ?",
                    (message, now_iso(), run_id),
                )
                db.commit()
            _recibos_job_update(
                running=False, phase="fim", percent=100, total=0, done=0, error=None,
                finishedAt=datetime.now().isoformat(timespec="seconds"), message=message,
            )
            return

        results = {}
        finished = 0
        progress(34, "recibos", f"Lendo {total} recibo(s) no S4E...")
        with ThreadPoolExecutor(max_workers=RECIBOS_WORKERS) as pool:
            futures = {
                pool.submit(_recibos_fetch_item, session.clone(), item): item
                for item in selected
            }
            for future in as_completed(futures):
                item = futures[future]
                try:
                    results[item["parcela"]] = future.result()
                except Exception as exc:
                    results[item["parcela"]] = {
                        "status": "erro", "error": str(exc) or "Falha ao ler o recibo.", "expired": False,
                    }
                finished += 1
                progress(
                    34 + round(48 * finished / total), "recibos",
                    f"Lendo recibos no S4E: {finished} de {total}...",
                )

        expired = [item for item in selected if results.get(item["parcela"], {}).get("expired")]
        if expired:
            progress(82, "recibos", "Sessão do S4E expirada. Entrando novamente e repetindo os pendentes...")
            try:
                s4e.disconnect()
                session = s4e.ensure_session()
                for item in expired:
                    results[item["parcela"]] = _recibos_fetch_item(session, item)
            except Exception:
                pass

        logo = b""
        logo_path = next(
            (
                item.get("fields", {}).get("logo")
                for item in results.values()
                if item.get("status") == "ok" and item.get("fields", {}).get("logo")
            ),
            "",
        )
        if logo_path:
            try:
                logo = s4e.fetch_receipt_logo(session, logo_path)
            except Exception:
                logo = b""

        progress(86, "pdf", "Montando os PDFs e organizando as pastas...")
        run_dir = RECIBOS_DIR / run_id
        written = []
        summary = [[
            "Centro de custo", "Grupo", "Empresa", "CNPJ", "Parcela", "Vencimento",
            "Valor", "Pagamento", "Competência", "Arquivo", "Situação",
        ]]
        for index, item in enumerate(selected, start=1):
            outcome = results.get(item["parcela"]) or {"status": "erro", "error": "Recibo não lido."}
            status = outcome.get("status") or "erro"
            error = outcome.get("error") or ""
            target = None
            if status == "ok":
                fields = outcome.get("fields") or {}
                if _recibos_value(fields.get("valor")) <= 0:
                    status = "ignorado"
                    error = "Recibo sem valor recebido."
                else:
                    try:
                        folder = (
                            run_dir
                            / _recibos_safe(item["centro"], "Sem centro de custo")
                            / _recibos_safe(item["grupo"], "Sem grupo")
                            / _recibos_safe(item["empresa"], "Sem empresa")
                        )
                        folder.mkdir(parents=True, exist_ok=True)
                        target = folder / f"recibo-{item['parcela']}.pdf"
                        target.write_bytes(recibos_pdf.build_receipt_pdf(fields, logo))
                        generated += 1
                        companies.add((item["centro"], item["grupo"], item["empresa"]))
                    except Exception as exc:
                        status = "erro"
                        error = str(exc) or "Falha ao gerar o PDF."
            if status == "erro":
                errors += 1
            elif status == "ignorado":
                skipped += 1
            path_text = str(target) if target else ""
            if target:
                written.append(target)
            with connection() as db:
                db.execute(
                    "INSERT INTO recibo_items(id, run_id, parcela, empresa, documento, grupo_mae, "
                    "grupo_empresa, vencimento, valor, data_credito, competencia, tipo_parcela, "
                    "path, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid.uuid4()), run_id, item["parcela"], item["empresa"], item["documento"],
                        item["centro"], item["grupo"], item["vencimento"], item["valor"],
                        item["dataCredito"], item["competencia"], item["tipoParcela"],
                        path_text, status, error,
                    ),
                )
                db.commit()
            summary.append([
                item["centro"], item["grupo"], item["empresa"], item["documento"],
                item["parcela"], item["vencimento"], f"{item['valor']:.2f}".replace(".", ","),
                item["dataCredito"], item["competencia"],
                target.relative_to(run_dir).as_posix() if target else "",
                "Gerado" if status == "ok" else ("Sem valor recebido" if status == "ignorado" else error),
            ])
            if index % 10 == 0 or index == total:
                progress(86 + round(8 * index / total), "pdf", f"Gerando PDFs: {index} de {total}...")

        progress(95, "zip", "Compactando a pasta de recibos...")
        RECIBOS_DIR.mkdir(parents=True, exist_ok=True)
        zip_path = RECIBOS_DIR / f"recibos-{run_id[:8]}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as package:
            for target in written:
                package.write(target, arcname=target.relative_to(run_dir).as_posix())
            buffer = io.StringIO()
            writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
            writer.writerows(summary)
            package.writestr("resumo.csv", "\ufeff" + buffer.getvalue())

        message = f"{generated} recibo(s) em PDF para {len(companies)} empresa(s)."
        if skipped:
            message += f" {skipped} recibo(s) sem valor foram deixados de fora."
        if errors:
            message += f" {errors} recibo(s) não puderam ser lidos."
        with connection() as db:
            db.execute(
                "UPDATE recibo_runs SET status = 'done', phase = 'fim', message = ?, gerados = ?, "
                "ignorados = ?, erros = ?, empresas = ?, folder = ?, zip_path = ?, finished_at = ?, "
                "error = NULL WHERE id = ?",
                (
                    message, generated, skipped, errors, len(companies),
                    str(run_dir), str(zip_path), now_iso(), run_id,
                ),
            )
            db.commit()
            _recibos_prune(db)
        _recibos_job_update(
            running=False, phase="fim", percent=100, done=generated, total=total,
            finishedAt=datetime.now().isoformat(timespec="seconds"), message=message, error=None,
        )
    except Exception as exc:
        message = str(exc) or "Falha inesperada na geração dos recibos."
        try:
            with connection() as db:
                db.execute(
                    "UPDATE recibo_runs SET status = 'error', phase = 'erro', message = ?, "
                    "finished_at = ?, error = ? WHERE id = ?",
                    (message, now_iso(), message, run_id),
                )
                db.commit()
        finally:
            _recibos_job_update(
                running=False, phase="erro", percent=100, error=message, message=message,
                finishedAt=datetime.now().isoformat(timespec="seconds"),
            )


AUTO_TZ = timezone(timedelta(hours=-3))
AUTO_WINDOW_START = 7
AUTO_WINDOW_END = 19
APURACAO_AUTO_INTERVAL = 30
APURACAO_AUTO_BACKOFF = 60
COBRANCA_AUTO_INTERVAL = 180
AUTO_RETRY_BLOCK = 15 * 60
COBRANCA_AUTO_LAST_KEY = "cobranca_auto_last"
COBRANCA_AUTO_USER = {"id": "sistema", "display_name": "Sistema (automático)", "username": "sistema"}

_apuracao_scheduler_lock = threading.Lock()
_cobranca_scheduler_lock = threading.Lock()
# Evita que a apuração e a cobrança automáticas abram dois relatórios ao mesmo tempo.
_auto_start_lock = threading.Lock()
_apuracao_auto_block_until = 0.0
_cobranca_auto_block_until = 0.0


def _auto_now():
    return datetime.now(AUTO_TZ)


def _auto_window_open(now=None):
    now = now or _auto_now()
    return now.weekday() <= 4 and AUTO_WINDOW_START <= now.hour < AUTO_WINDOW_END


def _auto_age_minutes(value, now=None):
    if not value:
        return None
    try:
        at = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return max(0.0, (now - at.astimezone(timezone.utc)).total_seconds() / 60)


def _auto_due(last_at, interval_minutes, now=None):
    age = _auto_age_minutes(last_at, now)
    return age is None or age >= interval_minutes


def _s4e_auto_busy():
    return bool(
        apuracao_job_status().get("running")
        or s4e.job_status().get("running")
        or retornos._state.get("running")
        or vendas.job_status().get("running")
        or recibos_job_status().get("running")
    )


def _apuracao_recover_stale(db):
    stale = db.execute(
        "SELECT id, started_at FROM apuracao_runs WHERE status = 'running' ORDER BY started_at LIMIT 1"
    ).fetchone()
    if not stale:
        return
    age = _auto_age_minutes(stale["started_at"])
    active_job = apuracao_job_status()
    worker_active = active_job["running"] and active_job.get("runId") == stale["id"]
    if age is not None and age > 15 and not worker_active:
        db.execute(
            "UPDATE apuracao_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
            (now_iso(), "Execução interrompida por tempo excedido.", stale["id"]),
        )
        db.commit()


def apuracao_scheduler_maybe(now=None):
    global _apuracao_auto_block_until
    now = now or _auto_now()
    if not _auto_window_open(now):
        return
    if not _apuracao_scheduler_lock.acquire(blocking=False):
        return
    try:
        if time.monotonic() < _apuracao_auto_block_until or _s4e_auto_busy():
            return
        competencia = apuracao_competencia_label(now.year, now.month)
        with connection() as db:
            if system_lock_state(db)[0]:
                return
            _apuracao_recover_stale(db)
            last = db.execute(
                "SELECT status, started_at FROM apuracao_runs WHERE competencia_label = ? "
                "ORDER BY started_at DESC LIMIT 1",
                (competencia,),
            ).fetchone()
        interval = APURACAO_AUTO_BACKOFF if last and last["status"] == "error" else APURACAO_AUTO_INTERVAL
        if last and not _auto_due(last["started_at"], interval):
            return
        with _auto_start_lock:
            if _s4e_auto_busy():
                return
            try:
                apuracao_start_run(competencia, mode="auto", user_name="Sistema (automático)")
            except Exception as error:
                _apuracao_auto_block_until = time.monotonic() + AUTO_RETRY_BLOCK
                print(f"Falha na apuração automática: {error}", flush=True)
    finally:
        _apuracao_scheduler_lock.release()


def cobranca_existing_contacts(db):
    contacts = {}
    for row in db.execute(
        "SELECT cd_associado, emails, phones FROM cobranca_cases "
        "WHERE cd_associado != '' ORDER BY last_seen DESC"
    ):
        code = str(row["cd_associado"] or "").strip()
        if not code or code in contacts:
            continue
        emails = cobranca_clean_list(row["emails"])
        phones = cobranca_clean_list(row["phones"])
        if emails or phones:
            contacts[code] = {"emails": emails, "phones": phones}
    return contacts


def _meta_value(db, key):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else ""


def cobranca_auto_maybe(now=None):
    global _cobranca_auto_block_until
    now = now or _auto_now()
    if not _auto_window_open(now):
        return
    if not _cobranca_scheduler_lock.acquire(blocking=False):
        return
    try:
        if time.monotonic() < _cobranca_auto_block_until or _s4e_auto_busy():
            return
        with connection() as db:
            if system_lock_state(db)[0]:
                return
            if not s4e_account_config(db).get("password"):
                return
            last_import = db.execute("SELECT MAX(at) AS at FROM cobranca_imports").fetchone()
            last_attempt = max(
                [value for value in (_meta_value(db, COBRANCA_AUTO_LAST_KEY), last_import["at"] if last_import else "") if value],
                key=str,
                default="",
            )
            if last_attempt and not _auto_due(last_attempt, COBRANCA_AUTO_INTERVAL):
                return
            contacts = cobranca_existing_contacts(db)
        with _auto_start_lock:
            if _s4e_auto_busy():
                return
            try:
                s4e.start_import(
                    {
                        "withContacts": True,
                        "dryRun": False,
                        "source": "s4e-auto",
                        "existingContacts": contacts,
                    },
                    lambda rows, **kwargs: s4e_import_into_cobranca(COBRANCA_AUTO_USER, rows, **kwargs),
                )
            except Exception as error:
                _cobranca_auto_block_until = time.monotonic() + AUTO_RETRY_BLOCK
                print(f"Falha na importação automática da cobrança: {error}", flush=True)
                return
        with connection() as db:
            db.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (COBRANCA_AUTO_LAST_KEY, now_iso()),
            )
            db.commit()
    finally:
        _cobranca_scheduler_lock.release()


def apuracao_scheduler_worker():
    while True:
        try:
            apuracao_scheduler_maybe()
        except Exception as error:
            print(f"Falha no agendador da apuração: {error}", flush=True)
        time.sleep(30)


def cobranca_scheduler_worker():
    while True:
        try:
            cobranca_auto_maybe()
        except Exception as error:
            print(f"Falha no agendador da cobrança: {error}", flush=True)
        time.sleep(60)


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
        if deny_if_locked(self, path):
            return
        if path == "/api/agent/suggestions":
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
                rows = db.execute(
                    """SELECT e.id, e.event_type, e.screen, e.text, e.created_at, u.display_name
                       FROM portal_agent_events e JOIN users u ON u.id = e.user_id
                       WHERE e.created_at >= datetime('now', '-30 days')
                       ORDER BY e.created_at DESC LIMIT 200"""
                ).fetchall()
                state_row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
            existing_titles = set()
            if state_row:
                try:
                    state = json.loads(state_row["data"])
                    existing_titles = {
                        re.sub(r"\s+", " ", str(task.get("title") or "").strip()).casefold()
                        for task in state.get("tasks", [])
                        if isinstance(task, dict) and task.get("title")
                    }
                except (TypeError, ValueError):
                    existing_titles = set()
            keywords = ("preciso", "lembrar", "cobrar", "enviar", "conferir", "verificar", "atualizar", "resolver", "fazer")
            suggestions = []
            for row in rows:
                text = str(row["text"] or "").strip()
                lowered = text.lower()
                if len(text) < 12:
                    continue
                if row["event_type"] != "conversation" and not any(word in lowered for word in keywords):
                    continue
                if re.sub(r"\s+", " ", text).casefold() in existing_titles:
                    continue
                suggestions.append({
                    "id": row["id"], "title": text[:160], "source": row["display_name"],
                    "screen": row["screen"], "createdAt": row["created_at"],
                })
            self.send_json({"suggestions": suggestions[:30]})
            return
        if path == "/api/system/status":
            with connection() as db:
                locked, message, since = system_lock_state(db)
            self.send_json({"locked": locked, "message": message, "since": since})
            return
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
        if path == "/api/team/pulse":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                is_admin = user["role"] == "admin"
                manager_user = is_admin or bool(user["management"]) if "management" in user.keys() else is_admin
                if not manager_user:
                    self.send_json({"error": "Sem permissão."}, 403)
                    return
                sector_ids = [row["sector_id"] for row in db.execute("SELECT sector_id FROM user_sectors WHERE user_id = ?", (user["id"],))]
                if is_admin or ("management" in user.keys() and user["management"]):
                    team = [dict(row) for row in db.execute("SELECT DISTINCT id, display_name, username, role, last_login FROM users ORDER BY display_name")]
                elif sector_ids:
                    team = [dict(row) for row in db.execute(
                        f"SELECT DISTINCT u.id, u.display_name, u.username, u.role, u.last_login FROM users u JOIN user_sectors us ON us.user_id = u.id WHERE us.sector_id IN ({','.join('?' for _ in sector_ids)}) ORDER BY u.display_name",
                        sector_ids,
                    )]
                else:
                    team = [dict(row) for row in db.execute("SELECT id, display_name, username, role, last_login FROM users ORDER BY display_name")] if is_admin else []
                if not is_admin and not any(m["id"] == user["id"] for m in team):
                    team.insert(0, {"id": user["id"], "display_name": user["display_name"], "username": user["username"], "role": user["role"], "last_login": user["last_login"] if "last_login" in user.keys() else None})
                row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                state = json.loads(row["data"]) if row else {}
            tasks = [t for t in (state.get("tasks") or []) if isinstance(t, dict)]
            if not is_admin and not ("management" in user.keys() and user["management"]) and sector_ids:
                tasks = [t for t in tasks if t.get("sectorId") in sector_ids]
            members = []
            for m in team:
                mine = [t for t in tasks if t.get("owner") == m["display_name"]]
                done = [t for t in mine if t.get("status") == "done"]
                progress = [t for t in mine if t.get("status") == "progress"]
                todo = [t for t in mine if t.get("status") not in ("done", "progress")]
                overdue = [t for t in todo if str(t.get("due") or t.get("periodEnd") or "") < today_iso()]
                members.append({
                    "id": m["id"], "name": m["display_name"], "username": m["username"], "role": m["role"],
                    "lastLogin": m.get("last_login"),
                    "total": len(mine), "done": len(done), "progress": len(progress), "todo": len(todo), "overdue": len(overdue),
                })
            unassigned = [t for t in tasks if not t.get("owner") and t.get("status") != "done"]
            self.send_json({"members": members, "unassigned": len(unassigned), "generatedAt": now_iso()})
            return
        if path == "/api/directory":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                self.send_json(directory_payload(db, user))
            return
        if path == "/api/chat/conversations":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                channels = []
                unread_total = 0
                team_last = chat_last_message(db, "team", "")
                team_unread = chat_unread(db, user["id"], "team", "")
                unread_total += team_unread
                channels.append({
                    "scope": "team", "scopeId": "", "name": "Equipe", "subtitle": "Todos os perfis do portal",
                    "unread": team_unread, "lastMessage": team_last, "lastAt": team_last["createdAt"] if team_last else "",
                })
                if user["role"] == "admin":
                    sector_rows = db.execute("SELECT id, name FROM sectors ORDER BY name").fetchall()
                else:
                    sector_ids = user_sector_ids(db, user)
                    sector_rows = db.execute(
                        f"SELECT id, name FROM sectors WHERE id IN ({','.join('?' for _ in sector_ids)}) ORDER BY name",
                        sector_ids,
                    ).fetchall() if sector_ids else []
                for sector in sector_rows:
                    last = chat_last_message(db, "sector", sector["id"])
                    unread = chat_unread(db, user["id"], "sector", sector["id"])
                    unread_total += unread
                    channels.append({
                        "scope": "sector", "scopeId": sector["id"], "name": sector["name"], "subtitle": "Canal do setor",
                        "unread": unread, "lastMessage": last, "lastAt": last["createdAt"] if last else "",
                    })
                people = []
                _, people_by_name = user_directory_index(db)
                my_photo = (user["photo"] if "photo" in user.keys() else "") or ""
                if not my_photo:
                    my_photo = people_by_name.get(normalize_name(user["display_name"]), {}).get("photo", "")
                for row in db.execute(
                    "SELECT id, display_name, role, sector_id, photo, status_emoji, status_text, status_until FROM users WHERE id != ? ORDER BY display_name",
                    (user["id"],),
                ):
                    scope_id = "|".join(sorted([user["id"], row["id"]]))
                    last = chat_last_message(db, "direct", scope_id)
                    unread = chat_unread(db, user["id"], "direct", scope_id)
                    unread_total += unread
                    people.append({
                        "id": row["id"], "name": row["display_name"], "photo": row["photo"] or people_by_name.get(normalize_name(row["display_name"]), {}).get("photo", ""),
                        "role": row["role"], "sector": sector_name(db, row["sector_id"]), "status": user_status(row),
                        "scope": "direct", "scopeId": scope_id, "unread": unread,
                        "lastMessage": last, "lastAt": last["createdAt"] if last else "",
                    })
                people.sort(key=lambda item: item["name"].lower())
                people.sort(key=lambda item: item["lastAt"] or "", reverse=True)
            self.send_json({
                "channels": channels,
                "people": people,
                "unreadTotal": unread_total,
                "me": {"id": user["id"], "name": user["display_name"], "photo": my_photo},
            })
            return
        if path == "/api/chat/messages":
            query = parse_qs(urlparse(self.path).query)
            normalized = normalize_chat_scope((query.get("scope") or [""])[0], (query.get("scopeId") or [""])[0])
            if not normalized:
                self.send_json({"error": "Conversa inválida."}, 400)
                return
            scope, scope_id = normalized
            after = str((query.get("after") or [""])[0]).strip()
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not chat_access(db, user, scope, scope_id):
                    self.send_json({"error": "Você não participa desta conversa."}, 403)
                    return
                base = """SELECT m.*, u.display_name, u.photo FROM chat_messages m
                          LEFT JOIN users u ON u.id = m.user_id
                          WHERE m.scope = ? AND m.scope_id = ?"""
                if after:
                    rows = db.execute(
                        f"{base} AND m.created_at > ? ORDER BY m.created_at ASC LIMIT 200",
                        (scope, scope_id, after),
                    ).fetchall()
                else:
                    rows = db.execute(
                        f"{base} ORDER BY m.created_at DESC LIMIT 100",
                        (scope, scope_id),
                    ).fetchall()[::-1]
                messages = [chat_message_payload(row) for row in rows]
                chat_mark_read(db, user["id"], scope, scope_id)
                db.commit()
            self.send_json({"messages": messages, "scope": scope, "scopeId": scope_id, "serverTime": now_iso()})
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
                screens = [
                    screen_payload(row)
                    for row in db.execute("SELECT * FROM screens WHERE id NOT IN (?, ?, ?) ORDER BY kind, name", tuple(DISABLED_SCREENS))
                ]
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
                if ensure_recurring_occurrences(state, db):
                    db.execute("BEGIN IMMEDIATE")
                    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                    state = json.loads(row["data"]) if row else {}
                    if ensure_recurring_occurrences(state, db):
                        db.execute(
                            "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
                            (json.dumps(state, ensure_ascii=False),),
                        )
                    db.commit()
            self.send_json(filter_state_for_user(state, user, db))
            return
        if path == "/api/cobranca":
            query = parse_qs(urlparse(self.path).query)
            where, params = cobranca_filters_from_query(query)
            sort_key = (query.get("sort") or ["venc_asc"])[0]
            sort = COBRANCA_SORTS.get(sort_key, COBRANCA_SORTS["venc_asc"])
            try:
                page = max(1, int((query.get("page") or ["1"])[0]))
            except (TypeError, ValueError):
                page = 1
            try:
                page_size = int((query.get("pageSize") or ["50"])[0])
            except (TypeError, ValueError):
                page_size = 50
            page_size = max(1, min(200, page_size))
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                mode = (query.get("mode") or ["empresas"])[0].strip().lower()
                if mode == "empresas":
                    where, params = cobranca_company_search_filter(db, where, params, query)
                summary = cobranca_summary(db, where, params)
                templates = db.execute(
                    "SELECT * FROM cobranca_templates WHERE active = 1 ORDER BY channel, name COLLATE NOCASE"
                ).fetchall()
                facets = cobranca_facet_payload(db, query)
                imports = db.execute(
                    "SELECT * FROM cobranca_imports ORDER BY at DESC LIMIT 10"
                ).fetchall()
                can_manage = is_manager(user)
                if mode == "empresas":
                    cc_map = cobranca_group_cc_map(db)
                    all_rows = db.execute(
                        f"SELECT * FROM cobranca_cases WHERE {where} ORDER BY vencimento ASC, valor DESC",
                        params,
                    ).fetchall()
                    companies = cobranca_sort_companies(cobranca_group_companies(all_rows, cc_map), sort_key)
                    summary.update(cobranca_company_counts(companies))
                    total = len(companies)
                    total_pages = 1
                    page = 1
                    items = [cobranca_company_public(company) for company in companies]
                else:
                    total = summary["rows"]
                    total_pages = max(1, (total + page_size - 1) // page_size)
                    page = min(page, total_pages)
                    rows = db.execute(
                        f"SELECT * FROM cobranca_cases WHERE {where} ORDER BY {sort} LIMIT ? OFFSET ?",
                        (*params, page_size, (page - 1) * page_size),
                    ).fetchall()
                    items = [cobranca_case_payload(row) for row in rows]
                    summary.update(cobranca_company_counts(cobranca_group_companies(
                        db.execute(f"SELECT * FROM cobranca_cases WHERE {where}", params).fetchall()
                    )))
            self.send_json({
                "mode": mode,
                "items": items,
                "summary": summary,
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
                "total": total,
                "templates": [cobranca_template_payload(row) for row in templates],
                "tipos": facets["tipos"],
                "statusCounts": facets["statusCounts"],
                "groups": facets["groups"],
                "statusLabels": COBRANCA_STATUS_LABELS,
                "resultLabels": COBRANCA_RESULT_LABELS,
                "imports": [
                    {
                        "id": row["id"],
                        "at": row["at"],
                        "userName": row["user_name"],
                        "source": row["source"],
                        "total": row["total"],
                        "criados": row["criados"],
                        "atualizados": row["atualizados"],
                        "baixados": row["baixados"],
                        "ignorados": row["ignorados"],
                        "periodStart": row["period_start"],
                        "periodEnd": row["period_end"],
                    }
                    for row in imports
                ],
                "canManage": can_manage,
                "canDelete": user["role"] == "admin",
                "today": date.today().isoformat(),
            })
            return
        if path in ("/api/vendas", "/api/vendas/job"):
            with connection() as db:
                if not require_admin(db, self):
                    return
                if path == "/api/vendas/job":
                    result = {"job": vendas.job_status()}
                else:
                    query = parse_qs(urlparse(self.path).query)
                    try:
                        start, end = vendas.period({key: values[0] for key, values in query.items() if key in ("start", "end")})
                    except (ValueError, TypeError) as exc:
                        self.send_json({"error": str(exc)}, 400)
                        return
                    result = vendas.overview(db, start, end)
            self.send_json(result)
            return
        if path == "/api/vidas/pessoas":
            with connection() as db:
                if not require_vidas(db, self):
                    return
                query = parse_qs(urlparse(self.path).query)
                params = {key: (values[0] or "").strip() for key, values in query.items()}
                result = vidas.people(
                    db,
                    busca=params.get("busca", ""),
                    situacao=params.get("situacao", ""),
                    parentesco=params.get("parentesco", ""),
                    centro=params.get("centro", ""),
                    limite=params.get("limite", 300),
                )
            self.send_json(result)
            return
        if path == "/api/vidas/exportar":
            with connection() as db:
                if not require_vidas(db, self):
                    return
                query = parse_qs(urlparse(self.path).query)
                params = {key: values[0] for key, values in query.items() if key in ("start", "end", "centro", "grupo")}
                try:
                    start, end = vendas.period({"start": params.get("start"), "end": params.get("end")})
                except (ValueError, TypeError) as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                body = vidas.report(
                    db, start, end,
                    (params.get("centro") or "").strip(),
                    (params.get("grupo") or "").strip(),
                )
            filename = f"movimentacao-de-vidas-{start:%Y%m%d}-a-{end:%Y%m%d}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ("/api/vidas", "/api/vidas/job"):
            with connection() as db:
                if not require_vidas(db, self):
                    return
                if path == "/api/vidas/job":
                    result = {"job": vendas.job_status()}
                else:
                    query = parse_qs(urlparse(self.path).query)
                    params = {key: values[0] for key, values in query.items() if key in ("start", "end", "centro", "grupo")}
                    try:
                        start, end = vendas.period({"start": params.get("start"), "end": params.get("end")})
                    except (ValueError, TypeError) as exc:
                        self.send_json({"error": str(exc)}, 400)
                        return
                    result = vidas.overview(
                        db, start, end,
                        (params.get("centro") or "").strip(),
                        (params.get("grupo") or "").strip(),
                    )
                    result["job"] = vendas.job_status()
            self.send_json(result)
            return
        if path == "/api/semanal":
            with connection() as db:
                if not require_weekly(db, self):
                    return
                query = parse_qs(urlparse(self.path).query)
                params = {key: values[0] for key, values in query.items() if key in ("start", "end")}
                try:
                    start, end = relatorio_semanal.period(params)
                except (ValueError, TypeError) as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                result = relatorio_semanal.overview(db, start, end)
            self.send_json(result)
            return
        if path in ("/api/retornos", "/api/retornos/detalhes"):
            with connection() as db:
                if not require_retornos(db, self):
                    return
                if path == "/api/retornos":
                    query = parse_qs(urlparse(self.path).query)
                    try:
                        start, end = retornos.period({key: values[0] for key, values in query.items() if key in ("start", "end")})
                    except (ValueError, TypeError) as exc:
                        self.send_json({"error": str(exc)}, 400)
                        return
                    result = retornos.overview(db, start, end)
                else:
                    query = parse_qs(urlparse(self.path).query)
                    lote_id = (query.get("id") or [""])[0]
                    if not re.fullmatch(r"[0-9]+", lote_id):
                        self.send_json({"error": "Identificador de lote inválido."}, 400)
                        return
                    result = retornos.detail(db, lote_id)
                    if result is None:
                        self.send_json({"error": "Lote ainda não consultado pelo monitor."}, 404)
                        return
            self.send_json(result)
            return
        if path == "/api/s4e/status":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                config = s4e_account_config(db)
                account = s4e_account_public(config)
                if account["configured"] and not reveal_secret(config.get("password")):
                    # Banco restaurado em outro computador: o DPAPI não abre o segredo.
                    account = s4e_account_public({})
                can_manage = is_manager(user)
            payload = s4e.status()
            payload["account"] = account
            payload["canManage"] = can_manage
            self.send_json(payload)
            return
        if path == "/api/cobranca/templates":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                rows = db.execute("SELECT * FROM cobranca_templates ORDER BY channel, name COLLATE NOCASE").fetchall()
            self.send_json({"templates": [cobranca_template_payload(row) for row in rows]})
            return
        if path == "/api/cobranca/export":
            query = parse_qs(urlparse(self.path).query)
            where, params = cobranca_filters_from_query(query)
            sort = COBRANCA_SORTS.get((query.get("sort") or ["venc_asc"])[0], COBRANCA_SORTS["venc_asc"])
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                rows = db.execute(
                    f"SELECT * FROM cobranca_cases WHERE {where} ORDER BY {sort}", params
                ).fetchall()
            buffer = io.StringIO()
            writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
            writer.writerow([
                "Cliente", "CPF/CNPJ", "Empresa", "Tipo", "Competência", "Parcela", "Situação",
                "Vencimento", "Dias em atraso", "Valor", "Status", "Cobrar", "E-mail", "WhatsApp",
                "Último contato", "Próximo contato",
            ])
            for row in rows:
                item = cobranca_case_payload(row)
                venc = item["vencimento"]
                if re.match(r"^\d{4}-\d{2}-\d{2}$", venc):
                    venc = f"{venc[8:10]}/{venc[5:7]}/{venc[0:4]}"
                writer.writerow([
                    item["cliente"], item["documento"], item["empresa"], item["tipoLabel"],
                    item["competencia"], item["parcela"], item["situacao"], venc,
                    item["diasAtraso"], f'{item["valor"]:.2f}'.replace(".", ","), item["statusLabel"],
                    "Não" if (item["naoCobrar"] or item["cancelada"]) else "Sim",
                    "; ".join(item["emails"]), "; ".join(item["phones"]),
                    item["lastContactAt"] or "", item["nextContact"] or "",
                ])
            body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
            filename = f"cobranca-{date.today().strftime('%Y%m%d')}.csv"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/cobranca/export/xlsx":
            query = parse_qs(urlparse(self.path).query)
            where, params = cobranca_filters_from_query(query)
            sort = (query.get("sort") or ["venc_asc"])[0]
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                where, params = cobranca_company_search_filter(db, where, params, query)
                rows = db.execute(
                    f"SELECT * FROM cobranca_cases WHERE {where} ORDER BY vencimento ASC, valor DESC",
                    params,
                ).fetchall()
                cc_map = cobranca_group_cc_map(db)
            companies = cobranca_sort_companies(cobranca_group_companies(rows, cc_map), sort)
            body = cobranca_build_xlsx(companies)
            filename = f"cobranca-{date.today().strftime('%Y%m%d')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/cobranca/grupos":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                self.send_json({
                    "groups": cobranca_group_cc_public(db)["groups"],
                    "canManage": is_manager(user),
                })
            return
        if path == "/api/cobranca/envios":
            query = parse_qs(urlparse(self.path).query)
            search = (query.get("search") or [""])[0].strip()
            key = unquote((query.get("key") or [""])[0]).strip()
            status = (query.get("status") or [""])[0].strip()
            try:
                limit = int((query.get("limit") or ["100"])[0])
            except ValueError:
                limit = 100
            limit = max(1, min(limit, 500))
            where = ["1=1"]
            params = []
            if key:
                where.append("company_key = ?")
                params.append(key)
            if status in ("enviado", "falha"):
                where.append("status = ?")
                params.append(status)
            if search:
                like = f"%{search}%"
                digits = cobranca_only_digits(search)
                clauses = ["company_name LIKE ?", "email LIKE ?", "documento LIKE ?", "user_name LIKE ?"]
                params.extend([like] * 4)
                if digits:
                    clauses.append("replace(replace(replace(documento, '.', ''), '-', ''), '/', '') LIKE ?")
                    params.append(f"%{digits}%")
                where.append(f"({' OR '.join(clauses)})")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                rows = db.execute(
                    f"SELECT * FROM cobranca_sends WHERE {' AND '.join(where)} "
                    "ORDER BY at DESC LIMIT ?",
                    (*params, limit),
                ).fetchall()
                total = db.execute(
                    f"SELECT COUNT(*) AS total FROM cobranca_sends WHERE {' AND '.join(where)}",
                    params,
                ).fetchone()
            self.send_json({
                "sends": [cobranca_send_payload(row) for row in rows],
                "total": int(total["total"] or 0),
                "limit": limit,
            })
            return
        if path == "/api/cobranca/empresa":
            query = parse_qs(urlparse(self.path).query)
            key = unquote((query.get("key") or [""])[0]).strip()
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                company = cobranca_company_detail(db, key)
                if not company:
                    self.send_json({"error": "Empresa não encontrada na fila de cobrança."}, 404)
                    return
                case_ids = [item["id"] for item in company["casos"]]
                history = []
                contatos = 0
                if case_ids:
                    placeholders = ",".join("?" for _ in case_ids)
                    rows = db.execute(
                        f"SELECT * FROM cobranca_history WHERE case_id IN ({placeholders}) "
                        "ORDER BY at DESC LIMIT 150",
                        case_ids,
                    ).fetchall()
                    titulos = {
                        item["id"]: " · ".join(
                            part for part in (
                                item["competencia"],
                                f"parcela {item['parcela']}" if item["parcela"] else "",
                            ) if part
                        )
                        for item in company["casos"]
                    }
                    history = cobranca_history_group([
                        {**cobranca_history_payload(row), "titulo": titulos.get(row["case_id"], "")}
                        for row in rows
                    ])
                    enviados = db.execute(
                        "SELECT COUNT(DISTINCT substr(at, 1, 16) || '|' || channel || '|' || "
                        "COALESCE(result, '') || '|' || COALESCE(notes, '')) AS total "
                        f"FROM cobranca_history WHERE case_id IN ({placeholders})",
                        case_ids,
                    ).fetchone()
                    contatos = int(enviados["total"] or 0)
                public = cobranca_company_public(company, full=True)
                public["contactCount"] = contatos
                sends = db.execute(
                    "SELECT * FROM cobranca_sends WHERE company_key = ? ORDER BY at DESC LIMIT 60",
                    (company["key"],),
                ).fetchall()
                graph = cobranca_graph_config(db)
                smtp = cobranca_smtp_config(db)
            self.send_json({
                "company": public,
                "history": history,
                "sends": [cobranca_send_payload(row) for row in sends],
                "graph": cobranca_graph_public(graph),
                "email": cobranca_smtp_public(smtp),
            })
            return
        if path == "/api/apuracao":
            query = parse_qs(urlparse(self.path).query)
            competencia = (query.get("competencia") or [""])[0].strip()
            if not competencia:
                competencia = apuracao_competencia_label(date.today().year, date.today().month)
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                semana = (query.get("semana") or [""])[0].strip()
                if semana and semana not in {"1", "2", "3", "4"}:
                    self.send_json({"error": "Semana inválida."}, 400)
                    return
                payload = apuracao_overview(db, competencia, semana)
                payload["canManage"] = user["role"] == "admin"
            self.send_json(payload)
            return
        if path == "/api/rateios-faturamento/vidas":
            query = parse_qs(urlparse(self.path).query)
            competencia = (query.get("competencia") or [""])[0].strip() or apuracao_competencia_label(date.today().year, date.today().month)
            parcela = re.sub(r"\D", "", (query.get("parcela") or [""])[0])
            if not parcela:
                self.send_json({"error": "Informe a parcela para consultar as vidas."}, 400)
                return
            try:
                with connection() as db:
                    user = require_apuracao(db, self)
                    if not user:
                        return
                    context = rateio_lives_context(db, competencia, parcela)
                if apuracao_job_status().get("running"):
                    self.send_json({"error": "Aguarde a consulta de apuração terminar para abrir a lista nominal."}, 409)
                    return
                credentials = s4e_saved_credentials()
                if not credentials:
                    self.send_json({"error": "Configure a conta do S4E para consultar a lista nominal."}, 400)
                    return
                import s4e_usuarios
                session = s4e_usuarios.open_session(credentials)
                active = s4e_usuarios.fetch_company_associates(session, context["companyCode"])
                payload = rateio_lives_payload(context, active)
            except (ValueError, s4e.ConnectorError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except Exception as exc:
                self.send_json({"error": f"Não foi possível consultar as vidas no S4E: {exc}"}, 502)
                return
            self.send_json(payload)
            return
        if path == "/api/rateios-faturamento":
            query = parse_qs(urlparse(self.path).query)
            competencia = (query.get("competencia") or [""])[0].strip() or apuracao_competencia_label(date.today().year, date.today().month)
            filters = {key: (query.get(key) or [""])[0].strip() for key in ("vencimentoDe", "vencimentoAte", "pagamentoDe", "pagamentoAte", "creditoDe", "creditoAte", "tipoParcela", "pagamentoStatus")}
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                payload = rateio_overview(db, competencia, filters)
                payload["canManage"] = user["role"] == "admin"
            self.send_json(payload)
            return
        if path == "/api/rateios-faturamento/exportar":
            query = parse_qs(urlparse(self.path).query)
            competencia = (query.get("competencia") or [""])[0].strip() or apuracao_competencia_label(date.today().year, date.today().month)
            filters = {key: (query.get(key) or [""])[0].strip() for key in ("vencimentoDe", "vencimentoAte", "pagamentoDe", "pagamentoAte", "creditoDe", "creditoAte", "tipoParcela", "pagamentoStatus", "grupo", "grupoEmpresa", "empresa")}
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                body = rateio_build_xlsx(rateio_overview(db, competencia, filters))
            filename = f"rateio-faturamento-{competencia.replace('/', '-')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/apuracao/job":
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
            self.send_json(apuracao_job_status())
            return
        if path == "/api/apuracao/runs":
            query = parse_qs(urlparse(self.path).query)
            competencia = (query.get("competencia") or [""])[0].strip()
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                if competencia:
                    rows = db.execute(
                        "SELECT * FROM apuracao_runs WHERE competencia_label = ? ORDER BY started_at DESC LIMIT 12",
                        (competencia,),
                    ).fetchall()
                else:
                    rows = db.execute(
                        "SELECT * FROM apuracao_runs ORDER BY started_at DESC LIMIT 12"
                    ).fetchall()
            self.send_json({"runs": [
                {
                    "id": row["id"], "competencia": row["competencia_label"], "mode": row["mode"],
                    "status": row["status"], "startedAt": row["started_at"], "finishedAt": row["finished_at"],
                    "totalEmpresas": row["total_empresas"], "pagas": row["pagas"],
                    "error": row["error"], "hasFile": bool(row["file_path"]),
                    "createdBy": row["created_by"], "timings": _apuracao_timings(row["timings"]),
                }
                for row in rows
            ]})
            return
        if path == "/api/apuracao/detalhes":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            week = (query.get("semana") or [""])[0].strip()
            group = (query.get("grupo") or [""])[0].strip()
            if week and week not in {"1", "2", "3", "4"}:
                self.send_json({"error": "Semana inválida."}, 400)
                return
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                run = db.execute("SELECT id FROM apuracao_runs WHERE id = ? AND status = 'done'", (run_id,)).fetchone()
                if not run:
                    self.send_json({"empresas": []})
                    return
                rows = db.execute(
                    "SELECT empresa, documento, grupo_mae, nf, nf_url, competencia, vencimento, data_pagamento, pago "
                    "FROM apuracao_rows WHERE run_id = ? AND (? = '' OR grupo_mae = ?) ORDER BY empresa COLLATE NOCASE",
                    (run_id, group, group),
                ).fetchall()
            empresas = []
            for row in rows:
                match = re.match(r"^\s*\d{1,2}/\d{1,2}/\d{4}", str(row["vencimento"] or ""))
                day = int(match.group(0).split("/")[0]) if match else 0
                row_week = 1 if day <= 7 else 2 if day <= 14 else 3 if day <= 21 else 4
                if week and str(row_week) != week:
                    continue
                empresas.append({
                    "empresa": row["empresa"], "documento": row["documento"],
                    "grupo": row["grupo_mae"], "nf": row["nf"], "nfUrl": row["nf_url"], "competencia": row["competencia"],
                    "vencimento": row["vencimento"], "dataPagamento": row["data_pagamento"],
                    "semana": row_week, "pago": bool(row["pago"]),
                })
            self.send_json({"empresas": empresas})
            return
        if path == "/api/apuracao/mapa":
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                apuracao_seed_map(db)
                rows = db.execute(
                    "SELECT * FROM apuracao_map ORDER BY grupo_mae COLLATE NOCASE, grupo COLLATE NOCASE"
                ).fetchall()
                db.commit()
            self.send_json({"mapa": [
                {
                    "id": row["id"], "grupo": row["grupo"],
                    "tipoPagamento": row["tipo_pagamento"], "grupoMae": row["grupo_mae"],
                }
                for row in rows
            ]})
            return
        if path == "/api/apuracao/grupos-empresa":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                rows = db.execute(
                    "SELECT grupo_empresa, tipo_pagamento, COUNT(*) AS total FROM apuracao_rows "
                    "WHERE run_id = ? AND grupo_empresa != '' GROUP BY grupo_empresa, tipo_pagamento "
                    "ORDER BY grupo_empresa COLLATE NOCASE",
                    (run_id,),
                ).fetchall()
            self.send_json({"grupos": [
                {"grupo": row["grupo_empresa"], "tipoPagamento": row["tipo_pagamento"], "total": row["total"]}
                for row in rows
            ]})
            return
        if path == "/api/apuracao/planilha":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                run = db.execute("SELECT * FROM apuracao_runs WHERE id = ?", (run_id,)).fetchone()
            if not run or run["status"] != "done" or not run["file_path"]:
                self.send_json({"error": "Planilha concluída não encontrada."}, 404)
                return
            try:
                destino = Path(run["file_path"]).resolve()
                destino.relative_to(APURACAO_DIR.resolve())
                body = destino.read_bytes()
            except (ValueError, OSError, RuntimeError):
                self.send_json({"error": "Arquivo da apuração indisponível."}, 404)
                return
            filename = destino.name
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/apuracao/relatorio":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            report_type = (query.get("tipo") or [""])[0].strip()
            week = (query.get("semana") or [""])[0].strip()
            group = (query.get("grupo") or [""])[0].strip()
            if week and week not in {"1", "2", "3", "4"}:
                self.send_json({"error": "Semana inválida."}, 400)
                return
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
            try:
                body, filename = apuracao_relatorio_xlsx(run_id, report_type, week, group)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/notas":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            with connection() as db:
                if not require_admin(db, self):
                    return
                payload = s4e_notas.overview(db, run_id)
            self.send_json(payload)
            return
        if path == "/api/notas/job":
            with connection() as db:
                if not require_admin(db, self):
                    return
            self.send_json(s4e_notas.job_status())
            return
        if path == "/api/notas/runs":
            with connection() as db:
                if not require_admin(db, self):
                    return
                payload = s4e_notas.runs(db)
            self.send_json({"runs": payload})
            return
        if path == "/api/notas/export":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            with connection() as db:
                if not require_admin(db, self):
                    return
                try:
                    body, filename = s4e_notas.export_xlsx(db, run_id)
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 404)
                    return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/recibos":
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
                payload = recibos_overview(db)
            self.send_json(payload)
            return
        if path == "/api/recibos/previa":
            query = parse_qs(urlparse(self.path).query)
            start = (query.get("start") or [""])[0].strip()
            end = (query.get("end") or [""])[0].strip()
            centro = (query.get("centro") or [""])[0].strip()
            grupo = (query.get("grupo") or [""])[0].strip()
            try:
                start_day = _recibos_day(start)
                end_day = _recibos_day(end)
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            if end_day < start_day:
                self.send_json({"error": "A data final precisa ser depois da data inicial."}, 400)
                return
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
                previa = recibos_previa(db, start_day, end_day, centro, grupo)
            self.send_json(previa)
            return
        if path == "/api/recibos/job":
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
            self.send_json(recibos_job_status())
            return
        if path == "/api/recibos/itens":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
                run = db.execute("SELECT id FROM recibo_runs WHERE id = ?", (run_id,)).fetchone()
                if not run:
                    self.send_json({"error": "Geração de recibos não encontrada."}, 404)
                    return
                items = recibos_items(db, run_id)
            self.send_json({"items": items})
            return
        if path == "/api/recibos/download":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("id") or [""])[0].strip()
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
                run = db.execute("SELECT * FROM recibo_runs WHERE id = ?", (run_id,)).fetchone()
            if not run or run["status"] != "done" or not run["zip_path"]:
                self.send_json({"error": "Pasta de recibos concluída não encontrada."}, 404)
                return
            try:
                destino = Path(run["zip_path"]).resolve()
                destino.relative_to(RECIBOS_DIR.resolve())
                body = destino.read_bytes()
            except (ValueError, OSError, RuntimeError):
                self.send_json({"error": "Arquivo dos recibos indisponível."}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{destino.name}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/recibos/pdf":
            query = parse_qs(urlparse(self.path).query)
            run_id = (query.get("run") or [""])[0].strip()
            parcela = (query.get("parcela") or [""])[0].strip()
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
                item = db.execute(
                    "SELECT path FROM recibo_items WHERE run_id = ? AND parcela = ? AND path != ''",
                    (run_id, parcela),
                ).fetchone()
            if not item:
                self.send_json({"error": "Recibo em PDF não encontrado."}, 404)
                return
            try:
                destino = Path(item["path"]).resolve()
                destino.relative_to(RECIBOS_DIR.resolve())
                body = destino.read_bytes()
            except (ValueError, OSError, RuntimeError):
                self.send_json({"error": "Recibo em PDF indisponível."}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", f'inline; filename="{destino.name}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/cobranca/"):
            case_id = unquote(path[len("/api/cobranca/"):]).strip("/")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                case = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                if not case:
                    self.send_json({"error": "Cobrança não encontrada."}, 404)
                    return
                history = db.execute(
                    "SELECT * FROM cobranca_history WHERE case_id = ? ORDER BY at DESC LIMIT 80", (case_id,)
                ).fetchall()
            self.send_json({
                "case": cobranca_case_payload(case),
                "history": [cobranca_history_payload(row) for row in history],
            })
            return
        if path == "/api/adesoes":
            query = parse_qs(urlparse(self.path).query)
            mes = (query.get("mes") or [""])[0].strip()
            ano = (query.get("ano") or [""])[0].strip()
            tipo = (query.get("tipo") or [""])[0].strip()
            conferencia_status = (query.get("status") or [""])[0].strip()
            search = (query.get("search") or [""])[0].strip()
            
            try:
                with connection() as db:
                    user = require_admin(db, self)
                    if not user:
                        return
                    
                    where_parts = []
                    params = []
                    
                    if mes and ano:
                        try:
                            mes_int = int(mes)
                            ano_int = int(ano)
                            if 1 <= mes_int <= 12 and 1000 <= ano_int <= 9999:
                                start = f"{ano_int:04d}-{mes_int:02d}-01"
                                if mes_int == 12:
                                    end = f"{ano_int+1:04d}-01-01"
                                else:
                                    end = f"{ano_int:04d}-{mes_int+1:02d}-01"
                                where_parts.append("data_adesao >= ? AND data_adesao < ?")
                                params.extend([start, end])
                        except (ValueError, TypeError):
                            pass
                    
                    if tipo in ("WEB", "CRM"):
                        where_parts.append("tipo = ?")
                        params.append(tipo)
                    
                    if conferencia_status in ("pendente", "validado", "alerta", "erro"):
                        where_parts.append("conferencia_status = ?")
                        params.append(conferencia_status)
                    
                    if search:
                        where_parts.append("(UPPER(empresa) LIKE UPPER(?) OR UPPER(lote) LIKE UPPER(?))")
                        params.extend([f"%{search}%", f"%{search}%"])
                    
                    where_clause = " WHERE " + " AND ".join(where_parts) if where_parts else ""
                    
                    rows = db.execute(
                        f"SELECT * FROM adesoes {where_clause} ORDER BY data_adesao DESC LIMIT 500",
                        params
                    ).fetchall()
                    
                    try:
                        page = max(1, int((query.get("page") or ["1"])[0]))
                    except (TypeError, ValueError):
                        page = 1
                    
                    try:
                        page_size = int((query.get("pageSize") or ["50"])[0])
                    except (TypeError, ValueError):
                        page_size = 50
                    
                    page_size = max(1, min(200, page_size))
                    offset = (page - 1) * page_size
                    
                    # Get total count without limit
                    total_result = db.execute(
                        f"SELECT COUNT(*) as cnt FROM adesoes {where_clause}",
                        params
                    ).fetchone()
                    total = total_result["cnt"] if total_result else 0
                    
                    # Get paginated rows
                    rows = db.execute(
                        f"SELECT * FROM adesoes {where_clause} ORDER BY data_adesao DESC LIMIT ? OFFSET ?",
                        params + [page_size, offset]
                    ).fetchall()
                    
                    conferidos = sum(1 for r in rows if r["conferencia_status"] == "validado")
                    alertas = sum(1 for r in rows if r["conferencia_status"] == "alerta")
                    problemas = sum(1 for r in rows if r["conferencia_status"] == "erro")
                    pendentes = sum(1 for r in rows if r["conferencia_status"] == "pendente")
                    
                    adesoes = [{
                        "id": r["id"],
                        "lote": r["lote"],
                        "empresa": r["empresa"],
                        "dataEntrada": r["data_entrada"],
                        "dataAdesao": r["data_adesao"],
                        "vidas": r["vidas"],
                        "valor": r["valor"],
                        "tipo": r["tipo"],
                        "situacao": r["situacao"],
                        "statusConferencia": r["conferencia_status"],
                        "notasConferencia": r["notas_conferencia"],
                        "conferidoEm": r["conferido_em"],
                    } for r in rows]
                    
                    self.send_json({
                        "adesoes": adesoes,
                        "total": total,
                        "conferidos": conferidos,
                        "alertas": alertas,
                        "problemas": problemas,
                        "pendentes": pendentes,
                        "page": page,
                        "pageSize": page_size,
                        "pages": (total + page_size - 1) // page_size if total > 0 else 1,
                    })
            except Exception as exc:
                self.send_json({"error": str(exc)[:200]}, 500)
            return
        if path == "/api/finance/rateios":
            query = parse_qs(urlparse(self.path).query)
            where, params, date_column = finance_filters_from_query(query)
            order = FINANCE_SORTS.get((query.get("sort") or ["payment_desc"])[0], FINANCE_SORTS["payment_desc"])
            try:
                page = max(1, int((query.get("page") or ["1"])[0]))
            except (TypeError, ValueError):
                page = 1
            try:
                page_size = int((query.get("pageSize") or ["50"])[0])
            except (TypeError, ValueError):
                page_size = 50
            page_size = max(1, min(200, page_size))
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                summary = finance_summary(db, where, params, date_column)
                total = summary["rows"]
                total_pages = max(1, (total + page_size - 1) // page_size)
                page = min(page, total_pages)
                rows = db.execute(
                    f"SELECT * FROM finance_rateios WHERE {where} {order} LIMIT ? OFFSET ?",
                    (*params, page_size, (page - 1) * page_size),
                ).fetchall()
                imports = [
                    finance_import_payload(row)
                    for row in db.execute("SELECT * FROM finance_imports ORDER BY created_at DESC LIMIT 30")
                ]
                options = finance_filter_options(db)
                can_manage = is_manager(user)
            self.send_json({
                "items": [finance_rateio_payload(row) for row in rows],
                "summary": summary,
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
                "total": total,
                "filters": options,
                "imports": imports,
                "canManage": can_manage,
            })
            return
        if path == "/api/finance/rateios/export":
            query = parse_qs(urlparse(self.path).query)
            where, params, _date_column = finance_filters_from_query(query)
            order = FINANCE_SORTS.get((query.get("sort") or ["payment_desc"])[0], FINANCE_SORTS["payment_desc"])
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                rows = db.execute(f"SELECT * FROM finance_rateios WHERE {where} {order}", params).fetchall()
            body = finance_build_xlsx([dict(row) for row in rows])
            filename = f"rateios-{date.today().strftime('%Y%m%d')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/finance/rateios/occurrences":
            query = parse_qs(urlparse(self.path).query)
            where, params, _date_column = finance_filters_from_query(query)
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                rows = db.execute(
                    f"""SELECT occurrence AS name, COUNT(*) AS rows,
                               COALESCE(SUM(CASE WHEN trim(our_number) != '' AND payment_date != ''
                                                 THEN paid ELSE 0 END), 0) AS paid,
                               SUM(CASE WHEN trim(our_number) != '' AND payment_date != ''
                                        THEN 1 ELSE 0 END) AS exportable
                        FROM finance_rateios
                        WHERE {where}
                        GROUP BY occurrence
                        ORDER BY exportable DESC, occurrence COLLATE NOCASE""",
                    params,
                ).fetchall()
            self.send_json({
                "items": [
                    {
                        "key": row["name"] or FINANCE_CSV_EMPTY_OCCURRENCE,
                        "name": row["name"] or "",
                        "rows": row["rows"],
                        "exportable": row["exportable"],
                        "paid": round(row["paid"], 2),
                    }
                    for row in rows
                ],
            })
            return
        if path == "/api/finance/rateios/csv":
            query = parse_qs(urlparse(self.path).query)
            header_code = (query.get("header") or [""])[0].strip().upper()
            if not FINANCE_CSV_CODE_RE.fullmatch(header_code):
                self.send_json(
                    {"error": "Digite o código da primeira linha do CSV, com letras e números (ex.: PDNN00001005112026)."},
                    400,
                )
                return
            where, params, _date_column = finance_filters_from_query(query)
            if "occurrences" in query:
                where, params = finance_apply_occurrence_selection(where, params, query.get("occurrences") or [])
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                rows = db.execute(
                    f"SELECT * FROM finance_rateios WHERE {where} "
                    "ORDER BY (payment_date = '') ASC, payment_date ASC, file_name COLLATE NOCASE ASC, our_number ASC",
                    params,
                ).fetchall()
            grouped = {}
            seen = {}
            for row in rows:
                record = dict(row)
                number = str(record["our_number"] or "").strip()
                if not number or not str(record["payment_date"] or "").strip():
                    continue
                name = str(record["file_name"] or "").strip() or "rateios"
                key = (number, record["payment_date"], record["paid"], record["credit_date"])
                if key in seen.setdefault(name, set()):
                    continue
                seen[name].add(key)
                grouped.setdefault(name, []).append(record)
            if not grouped:
                self.send_json(
                    {"error": "Nenhum lançamento com nosso número e data de pagamento foi encontrado nos filtros atuais."},
                    400,
                )
                return
            files = [
                (finance_csv_filename(name), finance_build_csv(records, header_code))
                for name, records in grouped.items()
            ]
            if len(files) == 1:
                filename, body = files[0]
                content_type = "text/csv; charset=cp1252"
            else:
                buffer = io.BytesIO()
                used = set()
                with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                    for name, content in files:
                        candidate = name
                        index = 2
                        while candidate.lower() in used:
                            candidate = f"{name[:-4]} ({index}).csv"
                            index += 1
                        used.add(candidate.lower())
                        archive.writestr(candidate, content)
                body = buffer.getvalue()
                filename = f"rateios-csv-{date.today().strftime('%Y%m%d')}.zip"
                content_type = "application/zip"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}",
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/contracts/events":
            with connection() as db:
                if not require_contracts(db, self):
                    return
                try:
                    result = contract_events_page(db, parse_qs(urlparse(self.path).query, keep_blank_values=True))
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
            self.send_json(result)
            return
        if path == "/api/contracts":
            with connection() as db:
                user = require_contracts(db, self)
                if not user:
                    return
                rows = db.execute("SELECT * FROM contract_companies ORDER BY lower(name), name").fetchall()
                counts = {row["company_id"]: row["n"] for row in db.execute("SELECT company_id, COUNT(*) AS n FROM contract_lives GROUP BY company_id")}
                registered_counts = {
                    row["company_id"]: row["n"]
                    for row in db.execute("SELECT company_id, COUNT(*) AS n FROM contract_lives WHERE registered = 1 GROUP BY company_id")
                }
                month = f"{date.today().month:02d}"
                birthday_counts = {
                    row["company_id"]: row["n"]
                    for row in db.execute(
                        "SELECT company_id, COUNT(*) AS n FROM contract_lives WHERE substr(birth_date, 6, 2) = ? GROUP BY company_id",
                        (month,),
                    )
                }
                show_values = is_manager(user)
                companies = [
                    contract_company_payload(
                        row, counts.get(row["id"], 0), birthday_counts.get(row["id"], 0), show_values,
                        registered_counts.get(row["id"], 0),
                    )
                    for row in rows
                ]
                imports = [
                    {
                        "id": row["id"],
                        "companyId": row["company_id"],
                        "companyName": row["company_name"],
                        "fileName": row["file_name"],
                        "userName": row["user_name"],
                        "companiesCreated": row["companies_created"],
                        "companiesUpdated": row["companies_updated"],
                        "livesCreated": row["lives_created"],
                        "livesUpdated": row["lives_updated"],
                        "livesRemoved": row["lives_removed"],
                        "createdAt": row["created_at"],
                    }
                    for row in db.execute("SELECT * FROM contract_imports ORDER BY created_at DESC LIMIT 24")
                ]
                can_register = contracts_allowed(db, user)
            total_lives = sum(counts.values())
            total_registered = sum(registered_counts.values())
            self.send_json({
                "companies": companies,
                "summary": {
                    "companies": len(companies),
                    "lives": total_lives,
                    "registered": total_registered,
                    "pending": max(0, total_lives - total_registered),
                    "companiesRegistered": sum(1 for item in companies if item["companyRegistered"]),
                    "companiesPending": sum(1 for item in companies if not item["companyRegistered"]),
                    "birthdaysMonth": sum(birthday_counts.values()),
                    "incomplete": sum(1 for item in companies if not (item["cnpj"] and item["contactName"] and item["phone"] and item["email"])),
                    "avgLives": round(total_lives / len(companies), 1) if companies else 0,
                },
                "imports": imports,
                "month": date.today().month,
                "canRegister": can_register,
            })
            return
        if path == "/api/contracts/export":
            query = parse_qs(urlparse(self.path).query)
            scope = (query.get("scope") or ["companies"])[0]
            company_filter = (query.get("companyId") or [""])[0]
            if scope not in ("companies", "lives"):
                self.send_json({"error": "Exportação inválida."}, 400)
                return
            with connection() as db:
                user = require_contracts(db, self)
                if not user:
                    return
                show_values = is_manager(user)
                if scope == "companies":
                    rows = db.execute(
                        """SELECT c.*, COUNT(l.id) AS lives_count FROM contract_companies c
                           LEFT JOIN contract_lives l ON l.company_id = c.id
                           GROUP BY c.id ORDER BY lower(c.name), c.name"""
                    ).fetchall()
                elif company_filter:
                    rows = db.execute(
                        """SELECT l.*, c.name AS company_name, c.cnpj AS company_cnpj
                           FROM contract_lives l JOIN contract_companies c ON c.id = l.company_id
                           WHERE l.company_id = ? ORDER BY lower(l.name)""",
                        (company_filter,),
                    ).fetchall()
                else:
                    rows = db.execute(
                        """SELECT l.*, c.name AS company_name, c.cnpj AS company_cnpj
                           FROM contract_lives l JOIN contract_companies c ON c.id = l.company_id
                           ORDER BY lower(c.name), lower(l.name)"""
                    ).fetchall()
            buffer = io.StringIO()
            writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
            if scope == "companies":
                header = ["Empresa", "CNPJ", "Contato", "Telefone", "E-mail", "Contador", "E-mail do contador", "Plano"]
                if show_values:
                    header += ["Valor mensal", "Valor por vida", "Vidas iniciais"]
                header += ["Vendedor", "Início", "Status", "Vidas", "Observações"]
                writer.writerow(header)
                for row in rows:
                    line = [
                        row["name"], row["cnpj"], row["contact_name"], row["phone"], row["email"],
                        row["accountant_name"], row["accountant_email"], row["plan"],
                    ]
                    if show_values:
                        line += [
                            f"{row['monthly_value']:.2f}".replace(".", ","),
                            f"{row['value_per_life']:.2f}".replace(".", ","),
                            row["initial_lives"],
                        ]
                    line += [row["seller"], row["contract_start"], row["status"], row["lives_count"], row["notes"]]
                    writer.writerow(line)
                filename = "contratos-empresas.csv"
            else:
                writer.writerow(["Empresa", "CNPJ da empresa", "Nome", "CPF", "Nascimento", "Nome da mãe", "Celular", "E-mail", "Cargo", "Observações"])
                for row in rows:
                    writer.writerow([
                        row["company_name"], row["company_cnpj"], row["name"], row["cpf"],
                        row["birth_date"], row["mother_name"], row["phone"], row["email"],
                        row["role"], row["notes"],
                    ])
                filename = "contratos-vidas.csv"
            body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f"attachment; filename={filename}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/contracts/") and path.count("/") == 3:
            company_id = unquote(path.split("/api/contracts/", 1)[1])
            with connection() as db:
                user, can_register = require_lives_access(db, self, company_id)
                if not user:
                    return
                show_values = can_edit_contract_values(db, user)
                company, lives = contract_company_view(db, company_id, show_values)
            if not company:
                self.send_json({"error": "Empresa não encontrada."}, 404)
                return
            self.send_json({"company": company, "lives": lives, "canRegister": can_register})
            return
        if path == "/api/commissions":
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                scope = commission_scope(db, user)
                rows = [
                    row for row in db.execute("SELECT * FROM contract_companies ORDER BY lower(name), name").fetchall()
                    if company_in_scope(row, scope)
                ]
                companies = [commission_company_payload(db, row) for row in rows]
                seller_totals = {}
                for company in companies:
                    key = company["sellerKey"] or "sem-vendedor"
                    bucket = seller_totals.setdefault(key, {
                        "name": company["seller"] or "Sem vendedor",
                        "contracts": 0,
                        "lives": 0,
                        "revenue": 0.0,
                        "commission": 0.0,
                    })
                    bucket["contracts"] += 1
                    bucket["lives"] += company["totalLives"]
                    bucket["revenue"] += company["totalRevenue"]
                    bucket["commission"] += company["totalCommission"]
                sellers = sorted(seller_totals.values(), key=lambda item: item["commission"], reverse=True)
                for seller in sellers:
                    seller["revenue"] = round(seller["revenue"], 2)
                    seller["commission"] = round(seller["commission"], 2)
                summary = {
                    "contracts": len(companies),
                    "lives": sum(item["totalLives"] for item in companies),
                    "registered": sum(item["registeredCount"] for item in companies),
                    "pending": sum(item["pendingCount"] for item in companies),
                    "companiesRegistered": sum(1 for item in companies if item["companyRegistered"]),
                    "companiesPending": sum(1 for item in companies if not item["companyRegistered"]),
                    "revenue": round(sum(item["totalRevenue"] for item in companies), 2),
                    "commission": round(sum(item["totalCommission"] for item in companies), 2),
                    "movements": sum(len(item["movements"]) for item in companies),
                }
                mine = user_seller_name(user)
                can_register = contracts_allowed(db, user)
            self.send_json({
                "companies": companies,
                "summary": summary,
                "sellers": sellers,
                "rate": COMMISSION_RATE,
                "canManage": is_manager(user),
                "canRegister": can_register,
                "sellerName": mine,
            })
            return
        if path == "/api/commissions/events":
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                try:
                    result = contract_registration_events_page(
                        db, parse_qs(urlparse(self.path).query, keep_blank_values=True),
                        commission_scope(db, user),
                    )
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
            self.send_json(result)
            return
        if path.startswith("/api/commissions/companies/") and path.count("/") == 4:
            company_id = unquote(path.split("/api/commissions/companies/", 1)[1])
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Contrato não encontrado."}, 404)
                    return
                if not company_in_scope(row, commission_scope(db, user)):
                    self.send_json({"error": "Você só pode acessar os seus contratos."}, 403)
                    return
                company = commission_company_payload(db, row)
                lives = [
                    contract_life_payload(life)
                    for life in db.execute(
                        "SELECT * FROM contract_lives WHERE company_id = ? ORDER BY lower(name), name",
                        (company_id,),
                    ).fetchall()
                ]
                can_register = contracts_allowed(db, user)
            self.send_json({
                "company": company,
                "lives": lives,
                "canRegister": can_register,
                "canEditValues": True,
            })
            return
        if path == "/api/commissions/export":
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                scope = commission_scope(db, user)
                rows = [
                    row for row in db.execute("SELECT * FROM contract_companies ORDER BY lower(name), name").fetchall()
                    if company_in_scope(row, scope)
                ]
                companies = [commission_company_payload(db, row) for row in rows]
            buffer = io.StringIO()
            writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
            writer.writerow([
                "Cliente", "Tipo", "CNPJ", "Vendedor", "Produto", "Vidas iniciais",
                "Valor por vida", "Receita inicial", "Comissão inicial", "Meses lançados",
                "Receita movimentos", "Comissão movimentos", "Receita total", "Comissão total", "Status",
            ])
            money = lambda value: f"{float(value or 0):.2f}".replace(".", ",")
            for item in companies:
                writer.writerow([
                    item["name"], item["clientType"], item["cnpj"], item["seller"], item["plan"],
                    item["initialLives"], money(item["valuePerLife"]), money(item["initialTotal"]),
                    money(item["initialCommission"]), len(item["movements"]), money(item["movementTotal"]),
                    money(item["movementCommission"]), money(item["totalRevenue"]),
                    money(item["totalCommission"]), item["status"],
                ])
            body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=comissoes.csv")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
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
        if path == "/api/proxy/sindicatos":
            self._serve_sindicatos_proxy()
            return
        if path == "/api/feed":
            query = parse_qs(urlparse(self.path).query)
            try:
                limit = int((query.get("limit") or ["30"])[0])
            except (TypeError, ValueError):
                limit = 30
            limit = max(1, min(limit, 60))
            before = (query.get("before") or [""])[0].strip()
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                ensure_weekly_digest(db)
                sql = "SELECT * FROM feed_posts"
                params = []
                if before:
                    sql += " WHERE created_at < ?"
                    params.append(before)
                sql += " ORDER BY created_at DESC LIMIT ?"
                params.append(limit + 1)
                rows = db.execute(sql, params).fetchall()
                posts = [feed_post_view(db, row, user) for row in rows[:limit]]
                unread = feed_unread_count(db, user["id"])
            self.send_json({"posts": posts, "unread": unread, "hasMore": len(rows) > limit})
            return
        if path == "/api/feed/unread":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                ensure_weekly_digest(db)
                unread = feed_unread_count(db, user["id"])
            self.send_json({"unread": unread})
            return
        if path == "/api/feed/notices":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                rows = db.execute(
                    "SELECT * FROM feed_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
                    (user["id"],),
                ).fetchall()
                notices = [feed_notice_view(row) for row in rows]
                unread = sum(1 for notice in notices if not notice["seen"])
            self.send_json({"notices": notices, "unread": unread})
            return
        if path == "/api/portal-summary":
            with connection() as db:
                if not require_user(db, self):
                    return
                summary = portal_summary(db)
            self.send_json({"summary": summary})
            return
        if path == "/api/system-updates":
            with connection() as db:
                if not require_user(db, self):
                    return
                rows = db.execute(
                    "SELECT * FROM system_updates ORDER BY created_at DESC LIMIT 60"
                ).fetchall()
                updates = [system_update_view(row) for row in rows]
            self.send_json({"updates": updates})
            return
        if path == "/api/announcements":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                self.send_json({"announcements": self._get_announcements(db)})
            return
        if path == "/api/birthdays":
            with connection() as db:
                if not require_user(db, self):
                    return
                sectors = {row["id"]: row["name"] for row in db.execute("SELECT id, name FROM sectors")}
                rows = db.execute(
                    """SELECT b.*, u.username, u.role, u.sector_id, u.photo AS profile_photo
                       FROM birthdays b LEFT JOIN users u ON u.id = b.user_id
                       ORDER BY b.month, b.day, b.name"""
                ).fetchall()
                user_rows = db.execute("SELECT id, display_name, username, role, sector_id, photo FROM users").fetchall()
                linked = {row["user_id"] for row in rows if row["user_id"]}
                users_by_name = {}
                for person in user_rows:
                    key = normalize_name(person["display_name"])
                    if not key:
                        continue
                    current = users_by_name.get(key)
                    if current is None or (not current["photo"] and person["photo"]):
                        users_by_name[key] = person
                legacy = db.execute(
                    "SELECT id, display_name, username, birthday, sector_id, role, photo FROM users WHERE birthday IS NOT NULL AND trim(birthday) != '' ORDER BY display_name"
                ).fetchall()
            items = []
            for row in rows:
                when, days_until, age = next_anniversary(row["month"], row["day"], row["year"])
                match = None if row["user_id"] else users_by_name.get(normalize_name(row["name"]))
                if match:
                    linked.add(match["id"])
                match_photo = (match["photo"] if match else "") or ""
                sector_id = row["sector_id"] if row["user_id"] else (match["sector_id"] if match else None)
                username = row["username"] if row["user_id"] else (match["username"] if match else None)
                role = row["role"] if row["user_id"] else (match["role"] if match else None)
                photo = row["photo"] or row["profile_photo"] or match_photo
                items.append({
                    "id": row["id"],
                    "name": row["name"],
                    "userId": row["user_id"] or (match["id"] if match else None),
                    "username": username,
                    "role": role,
                    "sector": sectors.get(sector_id, ""),
                    "kind": row["kind"] if row["kind"] in ("team", "partner") else "team",
                    "note": row["note"] or "",
                    "birthday": birthday_iso(row["month"], row["day"], row["year"]),
                    "photo": photo,
                    "profilePhoto": row["profile_photo"] or match_photo,
                    "month": row["month"],
                    "day": row["day"],
                    "year": row["year"],
                    "nextDate": when.isoformat(),
                    "weekday": when.weekday(),
                    "daysUntil": days_until,
                    "age": age,
                })
            for row in legacy:
                if row["id"] in linked:
                    continue
                try:
                    day = datetime.strptime(row["birthday"], "%Y-%m-%d").date()
                except ValueError:
                    continue
                when, days_until, age = next_anniversary(day.month, day.day, day.year)
                items.append({
                    "id": f"user-{row['id']}",
                    "name": row["display_name"],
                    "userId": row["id"],
                    "username": row["username"],
                    "role": row["role"],
                    "sector": sectors.get(row["sector_id"], ""),
                    "kind": "team",
                    "note": "",
                    "birthday": row["birthday"],
                    "photo": "",
                    "profilePhoto": row["photo"] or "",
                    "month": day.month,
                    "day": day.day,
                    "year": day.year,
                    "nextDate": when.isoformat(),
                    "weekday": when.weekday(),
                    "daysUntil": days_until,
                    "age": age,
                })
            items.sort(key=lambda item: (item["daysUntil"], 0 if item["kind"] == "team" else 1, item["name"].lower()))
            self.send_json({"birthdays": items, "today": date.today().isoformat()})
            return
        self.serve_file(self.path)

    # ── Comunicados ──────────────────────────────────────────────────────────
    def _get_announcements(self, db):
        row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
        state = json.loads(row["data"]) if row else {}
        return state.get("announcements") or []

    def _save_announcements(self, db, items):
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
        state = json.loads(row["data"]) if row else {}
        state["announcements"] = items
        encoded = json.dumps(state, ensure_ascii=False)
        db.execute(
            "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
            (encoded,),
        )
        db.commit()

    SINDICATOS_URL = "https://appredesaude.com.br/2610_sindicatos.html"
    SINDICATOS_SCRIPT = r"""
<script>
(function(){
['nv','nv-css','nv-toast','nv-top','nv-dr','nv-bt'].forEach(function(i){var e=document.getElementById(i);if(e)e.remove()});
var LS={g:function(k,d){try{return JSON.parse(localStorage.getItem('nv:'+k))||d}catch(e){return d}},s:function(k,v){try{localStorage.setItem('nv:'+k,JSON.stringify(v))}catch(e){}}};
var css=`
:root{--ink:#14202b;--mut:#6b7785;--line:#e4e8ee;--bg:#f5f7fa;--brand:#005a8d;--brand-h:#00486f;--tonal:#eef2f6;--tonal-h:#e1e7ee;--ok:#1f9d63;--warn:#d99a00;--bad:#c93a3a}
body{background:var(--bg)!important;font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif!important;color:var(--ink);-webkit-font-smoothing:antialiased}
.container{max-width:1120px!important;background:transparent!important;box-shadow:none!important;padding:0 20px}
.header,.section-title-bar,.cards-container,.footer{display:none!important}
.main-content{padding:0!important}
#nv *{box-sizing:border-box}#nv button,#nv select,#nv input{font:inherit}
#nv .hero{padding:40px 0 4px}#nv .hero img{height:38px;width:auto;display:block}
#nv .hero h1{font-size:clamp(1.5rem,4.5vw,2.3rem);font-weight:700;letter-spacing:-.02em;margin:18px 0 8px;color:var(--ink)}
#nv .hero p{margin:0 0 14px;color:var(--mut);max-width:56ch;line-height:1.55}
#nv .upd{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 12px}
#nv .pg{margin-top:16px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px;max-width:560px}
#nv .pg div{height:8px;border-radius:9px;background:var(--tonal);overflow:hidden;display:flex}
#nv .pg i{display:block;height:100%;transition:width .4s}
#nv .pg .a{background:var(--ok)}#nv .pg .r{background:var(--warn)}
#nv .pg p{margin:8px 0 0;font-size:.84rem;color:var(--mut)}#nv .pg b{color:var(--ink)}
#nv .bar{position:sticky;top:0;z-index:10;background:var(--bg);padding:14px 0 8px;margin-top:10px;display:flex;flex-direction:column;gap:10px}
#nv .row1{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center}
#nv .search{position:relative;flex:1 1 280px;min-width:0}
#nv .search>i{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--mut);pointer-events:none}
#nv .search input{width:100%;height:46px;border:1px solid var(--line);border-radius:12px;background:#fff;padding:0 44px 0 42px;font-size:16px;color:var(--ink);outline:0;transition:border-color .15s,box-shadow .15s}
#nv .search input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,90,141,.14)}
#nv .search kbd{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:.72rem;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:1px 7px;background:var(--bg)}
#nv .search .x{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:var(--mut);cursor:pointer;display:none}
#nv .search.has kbd{display:none}#nv .search.has .x{display:block}
#nv .chips,#nv .tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#nv .chip,#nv .tb{height:40px;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:999px;padding:0 14px;font-size:.86rem;font-weight:550;cursor:pointer;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:background .15s,border-color .15s,transform .1s}
#nv .chip:hover,#nv .tb:hover{border-color:#c3ccd8}#nv .chip:active,#nv .tb:active{transform:scale(.97)}
#nv .chip b{font-weight:600;font-size:.75rem;color:var(--mut)}
#nv .chip.on{background:var(--ink);border-color:var(--ink);color:#fff}#nv .chip.on b{color:#aab6c3}
#nv select{height:40px;border:1px solid var(--line);border-radius:999px;background:#fff;padding:0 12px;color:var(--ink);font-size:.86rem;font-weight:550}
#nv .rec{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:.82rem;color:var(--mut)}
#nv .rec button{border:0;background:var(--tonal);color:var(--ink);border-radius:999px;padding:5px 11px;cursor:pointer;font-size:.8rem;font-weight:550}
#nv .status{color:var(--mut);font-size:.85rem;margin:6px 2px 0}
#nv .grp{margin-top:28px}
#nv .grp h2{display:flex;align-items:center;gap:10px;font-size:1.05rem;font-weight:650;margin:0 0 14px}
#nv .grp h2::after{content:"";flex:1;height:1px;background:var(--line)}
#nv .grp h2 span{font-size:.75rem;font-weight:600;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:2px 9px;order:2}
#nv .grp h2 em{font-style:normal;font-size:.8rem;font-weight:550;color:var(--mut);order:3}
#nv .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
#nv .card{background:#fff;border:1px solid var(--line);border-left:4px solid var(--line);border-radius:16px;display:flex;flex-direction:column;transition:border-color .15s,transform .15s,box-shadow .3s}
#nv .card:hover{transform:translateY(-2px)}
#nv .card.s1{border-left-color:var(--warn)}#nv .card.s2{border-left-color:var(--ok)}
#nv .card.hl{box-shadow:0 0 0 3px rgba(0,90,141,.35)}
#nv .top{display:flex;gap:12px;align-items:center;padding:16px 16px 0}
#nv .logo{width:60px;height:60px;flex:none;border:1px solid var(--line);border-radius:12px;padding:6px;display:grid;place-items:center;background:#fff}
#nv .logo img{max-width:100%;max-height:100%;object-fit:contain;width:auto!important;height:auto!important}
#nv .info{min-width:0;flex:1}
#nv .info h3{margin:0;font-size:1rem;font-weight:650;line-height:1.25;overflow-wrap:anywhere}
#nv .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
#nv .pill{font-size:.74rem;font-weight:550;color:var(--mut);background:var(--tonal);border-radius:999px;padding:3px 10px}
#nv .pill.pr{color:var(--brand);background:#e8f2f8}
#nv .pill.urg{color:#9a2a2a;background:#fdeaea}
#nv .star,#nv .chev{flex:none;width:38px;height:38px;border:0;border-radius:10px;background:transparent;color:#a9b3bf;cursor:pointer;font-size:1.05rem}
#nv .star:hover{background:var(--tonal)}#nv .star.on{color:#e0a100}
#nv .chev{display:none;transition:transform .2s}
#nv .body{display:flex;flex-direction:column;gap:12px;padding:14px 16px 16px}
#nv .st{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:var(--tonal);border-radius:12px;padding:4px}
#nv .st button{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--mut);font-size:.78rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 4px}
#nv .st button[aria-pressed=true]{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(20,32,43,.1)}
#nv .dot{width:8px;height:8px;border-radius:50%;background:#b7c0cb;display:inline-block}
#nv .d1{background:var(--warn)}#nv .d2{background:var(--ok)}
#nv .main{display:flex;flex-direction:column;gap:8px}
#nv .main a.pr{display:flex;align-items:center;justify-content:center;gap:9px;height:46px;border-radius:12px;background:var(--brand);color:#fff;font-weight:600;font-size:.93rem;text-decoration:none;transition:background .15s,transform .1s}
#nv .main a.pr:hover{background:var(--brand-h)}
#nv .sub{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#nv .sub a{display:flex;align-items:center;justify-content:center;gap:8px;height:44px;border-radius:12px;background:var(--tonal);color:var(--ink);font-weight:550;font-size:.88rem;text-decoration:none;transition:background .15s}
#nv .sub a:hover{background:var(--tonal-h)}
#nv .sub a:last-child:nth-child(odd){grid-column:span 2}
#nv a.bad{background:#fdeaea!important;color:var(--bad)!important;text-decoration:line-through}
#nv .main a:active,#nv .acts button:active{transform:scale(.97)}
#nv .acts{display:flex;flex-wrap:wrap;gap:6px}
#nv .acts button{flex:1 1 auto;height:38px;border:0;border-radius:10px;background:transparent;border:1px solid var(--line);color:var(--ink);font-size:.8rem;font-weight:550;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 10px}
#nv .acts button:hover{background:var(--tonal)}
#nv .sim{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--tonal);border-radius:12px;padding:8px 12px;font-size:.84rem}
#nv .sim input{width:84px;height:34px;border:1px solid var(--line);border-radius:9px;padding:0 10px;background:#fff;font-size:16px}
#nv .sim b{font-size:1rem}#nv .sim small{color:var(--mut)}
#nv .seg{display:flex;gap:4px;background:var(--tonal);border-radius:12px;padding:4px}
#nv .seg button{flex:1;min-height:38px;border:0;border-radius:9px;background:transparent;color:var(--mut);font-size:.82rem;font-weight:600;cursor:pointer;padding:0 6px}
#nv .seg button[aria-selected=true]{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(20,32,43,.1)}
#nv .panel[hidden]{display:none}
#nv .empty{text-align:center;padding:70px 20px;color:var(--mut)}
#nv .empty b{display:block;font-size:1.1rem;color:var(--ink);margin-bottom:6px}
#nv .empty button{margin-top:16px;height:42px;padding:0 18px;border:0;border-radius:12px;background:var(--ink);color:#fff;font-weight:600;cursor:pointer}
#nv-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);background:#14202b;color:#fff;padding:11px 18px;border-radius:12px;font:600 .88rem system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:90;max-width:90vw;text-align:center}
#nv-toast.show{opacity:1;transform:translate(-50%,0)}
#nv-top{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer;display:none;z-index:40}
#nv-top.show{display:block}
#nv-dr{position:fixed;inset:0;z-index:80;display:none}#nv-dr.on{display:block}
#nv-dr .bg{position:absolute;inset:0;background:rgba(20,32,43,.5)}
#nv-dr aside{position:absolute;top:0;right:0;bottom:0;width:min(640px,100%);background:#fff;display:flex;flex-direction:column;animation:nvin .22s ease;font-family:Inter,"Segoe UI",system-ui,sans-serif}
@keyframes nvin{from{transform:translateX(30px);opacity:0}}@keyframes nvup{from{transform:translateY(40px);opacity:0}}
#nv-dr header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
#nv-dr header b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
#nv-dr header a,#nv-dr header button{height:36px;min-width:36px;padding:0 12px;border:0;border-radius:10px;background:var(--tonal);color:var(--ink);font-size:.84rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px}
#nv-dr .tabs{display:flex;gap:6px;padding:10px 14px;overflow-x:auto;border-bottom:1px solid var(--line)}
#nv-dr .tabs button{flex:none;height:34px;border:1px solid var(--line);background:#fff;border-radius:999px;padding:0 14px;font-size:.84rem;font-weight:600;cursor:pointer;color:var(--ink)}
#nv-dr .tabs button.on{background:var(--ink);border-color:var(--ink);color:#fff}
#nv-dr iframe{flex:1;border:0;width:100%;background:#f5f7fa}
#nv-bt{display:none;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid var(--line);padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px));grid-template-columns:repeat(4,1fr);gap:4px}
#nv-bt button{border:0;background:none;color:var(--mut);display:flex;flex-direction:column;align-items:center;gap:3px;font:600 .68rem system-ui,sans-serif;padding:7px 0;border-radius:12px;cursor:pointer}
#nv-bt button i{font-size:1.05rem}#nv-bt button.on{color:var(--brand);background:#e8f2f8}
#nv a:focus-visible,#nv button:focus-visible,#nv input:focus-visible,#nv select:focus-visible,#nv-dr button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
@media(prefers-reduced-motion:reduce){#nv *,#nv-dr aside{transition:none!important;animation:none!important}}
@media(max-width:700px){
.container{padding:0 12px}body{padding-bottom:84px}
#nv .hero{padding-top:20px}#nv .hero p,#nv .search kbd,#nv .tb span{display:none}
#nv .hero h1{font-size:1.45rem;margin:12px 0 6px}
#nv .pg{padding:10px 14px}
#nv .chips,#nv .tools{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 -12px;padding:0 12px 2px;width:calc(100% + 24px)}
#nv .chips::-webkit-scrollbar,#nv .tools::-webkit-scrollbar{display:none}
#nv .grid{grid-template-columns:minmax(0,1fr);gap:8px}
#nv .card{border-radius:14px}#nv .card:hover{transform:none}
#nv .top{padding:12px 10px 12px 12px;cursor:pointer}
#nv .logo{width:48px;height:48px}
#nv .chev{display:grid;place-items:center}#nv .card.open .chev{transform:rotate(180deg)}
#nv .body{display:none;padding:0 12px 14px}#nv .card.open .body{display:flex}
#nv .acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(52px,1fr))}
#nv .acts button{height:46px}#nv .acts button span{display:none}
#nv .main a.pr,#nv .sub a{height:50px}
#nv .grp{margin-top:20px}
#nv-bt{display:grid}#nv-top{bottom:calc(78px + env(safe-area-inset-bottom,0px))}
#nv-toast{bottom:calc(86px + env(safe-area-inset-bottom,0px))}
#nv-dr aside{top:auto;left:0;height:90vh;border-radius:18px 18px 0 0;animation:nvup .22s ease}
}
@media print{
body{background:#fff!important;padding:0!important}
#nv .bar,#nv .acts,#nv .st,#nv .sim,#nv .star,#nv .chev,#nv .seg,#nv .pg,#nv .rec,#nv .hero p,#nv .sub,#nv-bt,#nv-top,#nv-toast,#nv-dr{display:none!important}
#nv .body{display:flex!important}#nv .grid{grid-template-columns:1fr 1fr}
#nv .card{break-inside:avoid;box-shadow:none;transform:none}
#nv .main a.pr{background:none;color:#000;height:auto;justify-content:flex-start;font-size:.75rem;word-break:break-all}
#nv .main a.pr::after{content:" " attr(href);font-weight:400;color:#555}
}`;
var stl=document.createElement('style');stl.id='nv-css';stl.textContent=css;document.head.appendChild(stl);
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
var norm=function(s){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()};
var fix=function(s){return s.replace(/(\S) (?=[ÁÉÍÓÚÂÊÔÇÃÕ][A-ZÁÉÍÓÚÂÊÔÇÃÕ])/g,'$1')};
var fmt=function(n){return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})};
var mob=function(){return matchMedia('(max-width:700px)').matches};
var KINDS=[[/saiba/i,'info','fa-circle-info','Saiba mais'],[/folder/i,'folder','fa-file-pdf','Folder'],[/e-?mail/i,'email','fa-envelope','E-mail'],[/banner/i,'banner','fa-image','Banner S4E'],[/manual/i,'manual','fa-book-open','Manual'],[/a4/i,'a4','fa-file-lines','Folha A4']];
var kind=function(t){return KINDS.find(function(k){return k[0].test(t)})||[0,'other','fa-arrow-up-right-from-square',t.trim()]};
var links=function(els){return [...els].map(function(a){var t=a.childNodes[0].textContent.replace(/\s*-\s*Venc\s*\d+/i,'').trim(),k=kind(t);return{href:a.href,k:k[1],icon:k[2],label:k[3]}})};
var data=[...document.querySelectorAll('.card-sindicato')].map(function(c){
  var all=c.querySelectorAll('a.botao-saiba-mais'),txt=[...all].map(function(a){return a.textContent}).join(' ');
  var sm=c.querySelector('a small'),price=sm?sm.textContent.trim():'',pm=price.match(/R\$\s*([\d.]+,\d+)/);
  var name=fix(c.querySelector('h3').innerText.replace(/\s+/g,' ').trim());
  return{name:name,nn:norm(name),slug:norm(name).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
    logo:c.querySelector('img.logomarca').src,venc:(txt.match(/Venc\s*(\d+)/)||[])[1]||'',
    price:price,num:pm?parseFloat(pm[1].replace(/\./g,'').replace(',','.')):0,unit:price.replace(/R\$\s*[\d.,]+\s*/,''),
    links:links(all),
    plans:[...c.querySelectorAll('.planos-jf section')].map(function(s){return{name:s.querySelector('h4').textContent.replace(/^Plano\s+/i,'').replace(/\s*\+\s*NR-1.*$/i,' + NR').trim(),links:links(s.querySelectorAll('a'))}})};
}).sort(function(a,b){return a.name.localeCompare(b.name,'pt')});
var byName=function(n){return data.find(function(d){return d.name===n})};
data.forEach(function(d){d.g=d.venc||'outros'});
var cd=function(v){var n=new Date(),t0=new Date(n.getFullYear(),n.getMonth(),n.getDate());var t=new Date(n.getFullYear(),n.getMonth(),+v);if(t<t0)t=new Date(n.getFullYear(),n.getMonth()+1,+v);return Math.round((t-t0)/864e5)};
var cdTxt=function(n){return n==0?'hoje':n==1?'amanhã':'em '+n+' dias'};
var S={q:'',dia:'',st:'',fav:false,sort:'az'};
var stat=LS.g('st',{}),fav=LS.g('fav',[]);var rec=LS.g('rec',[]);
var sim={},tab={},open=new Set(),bad={};
function linkSet(ls){
  var order=['info','email','folder','banner','manual','a4'];
  var p=ls.find(function(l){return l.k==='info'})||ls[0],rest=ls.filter(function(l){return l!==p});
  var a=function(l,c){return '<a '+(c?'class="pr'+(bad[l.href]?' bad':'')+'" ':(bad[l.href]?'class="bad" ':''))+'href="'+l.href+'" target="_blank" rel="noopener noreferrer" data-k="'+l.k+'"><i class="fa-solid '+l.icon+'"></i>'+esc(l.label)+'</a>'};
  return '<div class="main">'+a(p,1)+(rest.length?'<div class="sub">'+rest.map(function(l){return a(l)}).join('')+'</div>':'')+'</div>';
}
function card(d){
  var s=stat[d.name]||0,f=fav.includes(d.name),n=d.venc?cd(d.venc):null,sv=sim[d.name]||'';
  var pills=(n!==null?'<span class="pill'+(n<=3?' urg':'')+'">Vence dia '+d.venc+' · '+cdTxt(n)+'</span>':'')+(d.price?'<span class="pill pr">'+esc(d.price)+'</span>':'')+(d.plans.length?'<span class="pill">'+d.plans.length+' planos</span>':'');
  var hasMail=d.plans.length||d.links.some(function(l){return l.k==='email'}),hasBn=d.links.some(function(l){return l.k==='banner'}),at=tab[d.name]||0;
  var body=d.plans.length
    ?'<div class="seg" role="tablist">'+d.plans.map(function(p,i){return'<button role="tab" aria-selected="'+(i==at)+'" data-t="'+i+'">'+esc(p.name)+'</button>'}).join('')+'</div>'+d.plans.map(function(p,i){return'<div class="panel" data-p="'+i+'"'+(i!=at?' hidden':'')+'">'+linkSet(p.links)+'</div>'}).join('')
    :linkSet(d.links);
  return '<article class="card s'+s+(open.has(d.name)?' open':'')+'" id="c-'+d.slug+'" data-n="'+esc(d.name)+'">'
    +'<div class="top"><div class="logo"><img src="'+d.logo+'" alt="Logo '+esc(d.name)+'" loading="lazy"></div>'
    +'<div class="info"><h3>'+esc(d.name)+'</h3><div class="pills">'+pills+'</div></div>'
    +'<button class="star'+(f?' on':'')+'" data-star aria-pressed="'+f+'" aria-label="Favoritar '+esc(d.name)+'"><i class="fa-'+(f?'solid':'regular')+' fa-star"></i></button>'
    +'<span class="chev" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span></div>'
    +'<div class="body">'
    +'<div class="st" role="group" aria-label="Status de aprovação">'+['Pendente','Em revisão','Aprovado'].map(function(t,i){return'<button data-s="'+i+'" aria-pressed="'+(s===i)+'"><i class="dot d'+i+'"></i>'+t+'</button>'}).join('')+'</div>'
    +body
    +(d.num?'<div class="sim"><label>Simular com <input type="number" min="0" inputmode="numeric" placeholder="0" value="'+sv+'" aria-label="Quantidade de vidas"> vidas</label><b>'+(sv?fmt(d.num*sv):fmt(0))+'</b><small>'+esc(d.unit)+'</small></div>':'')
    +'<div class="acts">'
    +(hasMail?'<button data-a="mail" title="Copiar e-mail formatado"><i class="fa-regular fa-copy"></i><span>Copiar e-mail</span></button>':'')
    +'<button data-a="wa" title="Enviar por WhatsApp"><i class="fa-brands fa-whatsapp"></i><span>WhatsApp</span></button>'
    +'<button data-a="prev" title="Pré-visualizar"><i class="fa-regular fa-eye"></i><span>Ver aqui</span></button>'
    +'<button data-a="lnk" title="Copiar link deste sindicato"><i class="fa-solid fa-link"></i><span>Link</span></button>'
    +(hasBn?'<button data-a="bn" title="Baixar banner"><i class="fa-solid fa-download"></i><span>Banner</span></button>':'')
    +'</div></div></article>';
}
var h1=(document.querySelector('.header h1')||{textContent:'CCT e ACT Rede Saúde'}).textContent.trim();
h1=fix(h1).toLowerCase().replace(/(^|\s)\S/g,function(m){return m.toUpperCase()}).replace(/\bCct\b/,'CCT').replace(/\bAct\b/,'ACT').replace(/ E /,' e ');
var upd=(document.querySelector('.header h4')||{textContent:''}).textContent.replace(/^Atualizado em:?\s*/i,'').trim();
var logoEl=document.querySelector('.section-title-bar img');
var nv=document.createElement('div');nv.id='nv';
nv.innerHTML='<div class="hero">'+(logoEl?'<img src="'+logoEl.src+'" alt="Rede Saúde">':'')
  +'<h1>'+esc(h1)+'</h1><p>Abra o material, copie o e-mail pronto para colar, acompanhe o que já foi aprovado e simule o valor para a empresa.</p>'
  +(upd?'<span class="upd"><i class="fa-regular fa-clock"></i>Atualizado em '+esc(upd)+'</span>':'')
  +'<div class="pg" id="nv-pg"></div></div>'
  +'<div class="bar"><div class="row1"><div class="search"><i class="fa-solid fa-magnifying-glass"></i>'
  +'<input id="nv-q" type="search" placeholder="Buscar sindicato" aria-label="Buscar sindicato" autocomplete="off"><kbd>/</kbd>'
  +'<button class="x" aria-label="Limpar busca"><i class="fa-solid fa-xmark"></i></button></div>'
  +'<div class="chips" id="nv-chips"></div></div>'
  +'<div class="tools"><select id="nv-st" aria-label="Filtrar por status"><option value="">Todos os status</option><option value="0">Pendentes</option><option value="1">Em revisão</option><option value="2">Aprovados</option></select>'
  +'<select id="nv-so" aria-label="Ordenar"><option value="az">Ordem por dia</option><option value="venc">Vencimento mais próximo</option></select>'
  +'<button class="tb" id="nv-ck"><i class="fa-solid fa-link-slash"></i><span>Verificar links</span></button>'
  +'<button class="tb" id="nv-pr"><i class="fa-solid fa-print"></i><span>Imprimir</span></button></div></div>'
  +'<div class="rec" id="nv-rec"></div><div class="status" id="nv-status" aria-live="polite"></div><div id="nv-list"></div>';
document.querySelector('.main-content').prepend(nv);
var toast=document.createElement('div');toast.id='nv-toast';toast.setAttribute('role','status');document.body.appendChild(toast);
var topBtn=document.createElement('button');topBtn.id='nv-top';topBtn.setAttribute('aria-label','Voltar ao topo');topBtn.innerHTML='<i class="fa-solid fa-arrow-up"></i>';document.body.appendChild(topBtn);
var bt=document.createElement('nav');bt.id='nv-bt';bt.setAttribute('aria-label','Atalhos');
bt.innerHTML='<button data-b="home"><i class="fa-solid fa-house"></i>Início</button><button data-b="search"><i class="fa-solid fa-magnifying-glass"></i>Buscar</button><button data-b="fav"><i class="fa-solid fa-star"></i>Favoritos</button><button data-b="pend"><i class="fa-solid fa-hourglass-half"></i>Pendentes</button>';
document.body.appendChild(bt);
var dr=document.createElement('div');dr.id='nv-dr';dr.innerHTML='<div class="bg"></div><aside role="dialog" aria-modal="true" aria-label="Pré-visualização"><header><b></b><a class="ext" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i>Abrir</a><button class="dx" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button></header><div class="tabs"></div><iframe title="Pré-visualização"></iframe></aside>';
document.body.appendChild(dr);
var tt;var say=function(m){toast.textContent=m;toast.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){toast.classList.remove('show')},2400)};
var q=nv.querySelector('#nv-q'),box=nv.querySelector('.search'),list=nv.querySelector('#nv-list');
function render(){
  var t=norm(q.value.trim());S.q=q.value;
  var base=data.filter(function(d){return d.nn.includes(t)&&(!S.st||String(stat[d.name]||0)===S.st)&&(!S.fav||fav.includes(d.name))});
  var f=base.filter(function(d){return !S.dia||d.g===S.dia});
  var keys=[...new Set(data.map(function(d){return d.g}))].filter(function(k){return k!=='outros'}).sort(function(a,b){return S.sort==='venc'?cd(a)-cd(b):a-b}).concat(data.some(function(d){return d.g==='outros'})?['outros']:[]);
  var favs=f.filter(function(d){return fav.includes(d.name)});
  var sec=function(title,items,extra){return items.length?'<section class="grp"><h2>'+title+' <span>'+items.length+'</span>'+(extra?'<em>'+extra+'</em>':'')+'</h2><div class="grid">'+items.map(card).join('')+'</div></section>':''};
  var html=sec('Favoritos',favs,'');
  keys.forEach(function(k){var it=f.filter(function(d){return d.g===k&&!fav.includes(d.name)});html+=sec(k==='outros'?'Outros sindicatos':'Vence dia '+k,it,k==='outros'?'':cdTxt(cd(k)))});
  list.innerHTML=html||'<div class="empty"><b>Nenhum sindicato encontrado</b>Confira a grafia ou limpe os filtros.<br><button data-clear>Limpar filtros</button></div>';
  var cnt={};base.forEach(function(d){cnt[d.g]=(cnt[d.g]||0)+1});
  nv.querySelector('#nv-chips').innerHTML=[{k:'',t:'Todos',n:base.length}].concat(keys.map(function(k){return{k:k,t:k==='outros'?'Outros':'Dia '+k,n:cnt[k]||0}})).map(function(c){return'<button class="chip'+(c.k===S.dia?' on':'')+'" data-f="'+c.k+'">'+c.t+' <b>'+c.n+'</b></button>'}).join('');
  nv.querySelector('#nv-status').textContent=t?f.length+(f.length==1?' resultado':' resultados')+' para "'+q.value.trim()+'"':f.length+(f.length==1?' sindicato':' sindicatos');
  var ap=data.filter(function(d){return stat[d.name]==2}).length,rv=data.filter(function(d){return stat[d.name]==1}).length,N=data.length;
  nv.querySelector('#nv-pg').innerHTML='<div><i class="a" style="width:'+(ap/N*100)+'%"></i><i class="r" style="width:'+(rv/N*100)+'%"></i></div><p><b>'+ap+' de '+N+'</b> aprovados'+(rv?' · '+rv+' em revisão':'')+(N-ap-rv?' · '+(N-ap-rv)+' pendentes':'')+'</p>';
  nv.querySelector('#nv-rec').innerHTML=rec.length&&!t?'Recentes: '+rec.map(function(n){return'<button data-go="'+esc(n)+'">'+esc(n)+'</button>'}).join(''):'';
  nv.querySelector('#nv-st').value=S.st;nv.querySelector('#nv-so').value=S.sort;
  box.classList.toggle('has',!!q.value);
  bt.querySelector('[data-b=fav]').classList.toggle('on',S.fav);bt.querySelector('[data-b=pend]').classList.toggle('on',S.st==='0');
}
var visLinks=function(c){return[...c.querySelectorAll('a[data-k]')].filter(function(a){return!a.closest('.panel[hidden]')})};
function openDr(name,ls){
  var order=['info','email','folder','banner','manual','a4'];
  ls=ls.slice().sort(function(a,b){return order.indexOf(a.dataset.k)-order.indexOf(b.dataset.k)});
  var tabs=dr.querySelector('.tabs'),fr=dr.querySelector('iframe'),ext=dr.querySelector('.ext');
  dr.querySelector('b').textContent=name;
  tabs.innerHTML=ls.map(function(a,i){return'<button data-i="'+i+'">'+esc(a.textContent.trim())+'</button>'}).join('');
  var go=function(i){fr.src=ls[i].href;ext.href=ls[i].href;[...tabs.children].forEach(function(b,j){b.classList.toggle('on',i===j)})};
  tabs.onclick=function(e){var b=e.target.closest('button');if(b)go(+b.dataset.i)};go(0);
  dr.classList.add('on');document.body.style.overflow='hidden';dr.querySelector('.dx').focus();
}
var closeDr=function(){dr.classList.remove('on');dr.querySelector('iframe').src='about:blank';document.body.style.overflow=''};
dr.addEventListener('click',function(e){if(e.target.classList.contains('bg')||e.target.closest('.dx'))closeDr()});
async function copyMail(url){
  say('Preparando o e-mail…');
  try{
    var r=await fetch(url);if(!r.ok)throw 0;
    var doc=new DOMParser().parseFromString(await r.text(),'text/html');
    doc.querySelectorAll('[src],[href]').forEach(function(e){['src','href'].forEach(function(a){var v=e.getAttribute(a);if(v&&!/^(data:|mailto:|#|tel:)/.test(v)){try{e.setAttribute(a,new URL(v,url).href)}catch(_){}}})});
    var html=doc.body.innerHTML,text=doc.body.textContent.trim();
    if(navigator.clipboard&&window.ClipboardItem&&isSecureContext){
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([text],{type:'text/plain'})})]);
    }else{
      var d=document.createElement('div');d.contentEditable=true;d.style.cssText='position:fixed;left:-9999px;top:0';d.innerHTML=html;document.body.appendChild(d);
      var rg=document.createRange();rg.selectNodeContents(d);var s=getSelection();s.removeAllRanges();s.addRange(rg);document.execCommand('copy');s.removeAllRanges();d.remove();
    }
    say('E-mail copiado. Agora é só colar no Outlook');
  }catch(e){say('Não consegui copiar. Abra o e-mail e copie manualmente')}
}
async function dlBanner(url,name){
  try{var b=await(await fetch(url)).blob(),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='banner-s4e-'+name.toLowerCase().replace(/\s+/g,'-')+'.png';document.body.appendChild(a);a.click();a.remove();say('Baixando o banner')}
  catch(e){window.open(url,'_blank')}
}
function copyText(t,msg){
  if(navigator.clipboard&&isSecureContext)navigator.clipboard.writeText(t).then(function(){say(msg)},function(){say('Não consegui copiar')});
  else{var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');say(msg)}catch(_){say('Não consegui copiar')}ta.remove()}
}
function addRec(n){rec=[n].concat(rec.filter(function(x){return x!==n})).slice(0,5);LS.s('rec',rec);nv.querySelector('#nv-rec').innerHTML=!q.value?'Recentes: '+rec.map(function(x){return'<button data-go="'+esc(x)+'">'+esc(x)+'</button>'}).join(''):''}
function focusCard(name){
  S.dia='';S.st='';S.fav=false;q.value='';open.add(name);render();
  var d=byName(name),el=document.getElementById('c-'+d.slug);
  if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('hl');setTimeout(function(){el.classList.remove('hl')},2200)}
}
nv.addEventListener('click',async function(e){
  var T=e.target;var b;
  if(b=T.closest('.chip')){S.dia=b.dataset.f;return render()}
  if(T.closest('.x')){q.value='';render();return q.focus()}
  if(T.closest('[data-clear]')){S.dia='';S.st='';S.fav=false;q.value='';return render()}
  if(b=T.closest('[data-go]'))return focusCard(b.dataset.go);
  if(T.closest('#nv-pr'))return window.print();
  if(T.closest('#nv-ck'))return check(T.closest('#nv-ck'));
  var c=T.closest('.card');if(!c)return;
  var d=byName(c.dataset.n);
  if(T.closest('[data-star]')){var i=fav.indexOf(d.name);i>-1?fav.splice(i,1):fav.push(d.name);LS.s('fav',fav);say(i>-1?'Removido dos favoritos':'Adicionado aos favoritos');return render()}
  if(b=T.closest('.st button')){stat[d.name]=+b.dataset.s;LS.s('st',stat);if(b.dataset.s==='2')say(d.name+' aprovado');return render()}
  if(b=T.closest('.seg button')){tab[d.name]=+b.dataset.t;c.querySelectorAll('.seg button').forEach(function(x){x.setAttribute('aria-selected',x===b)});c.querySelectorAll('.panel').forEach(function(p){p.hidden=p.dataset.p!==b.dataset.t});return}
  if(b=T.closest('[data-a]')){
    var ls=visLinks(c),get=function(k){return ls.find(function(a){return a.dataset.k===k})},aa=b.dataset.a;
    if(aa==='mail'){var m=get('email');addRec(d.name);return m?copyMail(m.href):say('Sem e-mail')}
    if(aa==='wa'){var tx=['*'+d.name+'*'].concat(['info','folder','email'].map(function(k){return get(k)&&(get(k).textContent.trim()+': '+get(k).href)}).filter(Boolean)).join('\n');addRec(d.name);return window.open('https://wa.me/?text='+encodeURIComponent(tx),'_blank')}
    if(aa==='prev'){addRec(d.name);return openDr(d.name,ls)}
    if(aa==='lnk')return copyText(location.href.split('#')[0]+'#'+d.slug,'Link do sindicato copiado');
    if(aa==='bn'){var mn=get('banner');return mn&&dlBanner(mn.href,d.name)}
  }
  if(T.closest('a[data-k]')){addRec(d.name);return}
  if(mob()&&T.closest('.top')){var o=c.classList.toggle('open');o?open.add(d.name):open.delete(d.name)}
});
nv.addEventListener('input',function(e){
  if(e.target===q)return render();
  if(e.target.closest('.sim')){var c=e.target.closest('.card'),n=c.dataset.n,d=byName(n),v=Math.max(0,+e.target.value||0);sim[n]=v||'';c.querySelector('.sim b').textContent=fmt(d.num*v)}
});
nv.addEventListener('change',function(e){if(e.target.id==='nv-st'){S.st=e.target.value;render()}if(e.target.id==='nv-so'){S.sort=e.target.value;render()}});
bt.addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  if(b.dataset.b==='home')window.scrollTo({top:0,behavior:'smooth'});
  if(b.dataset.b==='search'){window.scrollTo({top:0,behavior:'smooth'});setTimeout(function(){q.focus()},250)}
  if(b.dataset.b==='fav'){S.fav=!S.fav;if(S.fav&&!fav.length){S.fav=false;say('Toque na estrela de um sindicato para favoritar')}render()}
  if(b.dataset.b==='pend'){S.st=S.st==='0'?'':'0';render()}
});
var checking=false;
async function check(btn){
  if(checking)return;checking=true;
  var urls=[...new Set(data.flatMap(function(d){return d.links.concat(...d.plans.map(function(p){return p.links}))}).map(function(l){return l.href}))];
  Object.keys(bad).forEach(function(k){delete bad[k]});var i=0,done=0,ruim=0;
  var lbl=btn.querySelector('span'),ic=btn.querySelector('i');ic.className='fa-solid fa-spinner fa-spin';
  var run=async function(){while(i<urls.length){var u=urls[i++];
    try{var r=await fetch(u,{method:'HEAD',cache:'no-store'});if(r.status===405||r.status===501)r=await fetch(u,{cache:'no-store'});if(r.status>=400){bad[u]=1;ruim++}}catch(_){}
    done++;lbl.textContent=done+'/'+urls.length}};
  await Promise.all(Array(6).fill(0).map(run));
  ic.className='fa-solid fa-link-slash';lbl.textContent='Verificar links';checking=false;render();
  say(ruim?ruim+(ruim==1?' link com problema':' links com problema')+', marcados em vermelho':'Todos os '+urls.length+' links responderam');
}
document.addEventListener('keydown',function(e){
  var typing=/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName);
  if(e.key==='/'&&!typing){e.preventDefault();q.focus()}
  if(e.key==='Escape'){if(dr.classList.contains('on'))closeDr();else if(document.activeElement===q){q.value='';render();q.blur()}}
});
topBtn.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'})});
addEventListener('scroll',function(){topBtn.classList.toggle('show',scrollY>700)},{passive:true});
var fromHash=function(){var h=decodeURIComponent(location.hash.slice(1)),d=data.find(function(x){return x.slug===h});if(d)focusCard(d.name)};
addEventListener('hashchange',fromHash);
render();fromHash();
})();
</script>
"""

    def _serve_sindicatos_proxy(self):
        """Busca o HTML da página de sindicatos, injeta o script de interface e serve."""
        try:
            req = urllib.request.Request(
                self.SINDICATOS_URL,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "pt-BR,pt;q=0.9",
                },
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                charset = "utf-8"
                ct = resp.headers.get("Content-Type", "")
                for part in ct.split(";"):
                    part = part.strip()
                    if part.lower().startswith("charset="):
                        charset = part.split("=", 1)[1].strip()
                html = raw.decode(charset, errors="replace")
        except Exception as exc:
            html = (
                f"<html><body><p style='font-family:sans-serif;padding:2rem;color:#c93a3a'>"
                f"Não foi possível carregar a página de sindicatos.<br><small>{exc}</small></p></body></html>"
            )

        # Injeta Font Awesome (necessário para os ícones do script) e o script logo antes de </body>
        fa_tag = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous">'
        if "</head>" in html:
            html = html.replace("</head>", fa_tag + "\n</head>", 1)
        else:
            html = fa_tag + html

        if "</body>" in html:
            html = html.replace("</body>", self.SINDICATOS_SCRIPT + "\n</body>", 1)
        else:
            html = html + self.SINDICATOS_SCRIPT

        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        if deny_if_locked(self, path):
            return
        if path == "/api/agent/events":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            text = re.sub(r"\s+", " ", str(payload.get("text") or "").strip())[:500]
            event_type = str(payload.get("eventType") or "activity").strip()[:40]
            screen = str(payload.get("screen") or "").strip()[:80]
            if not text:
                self.send_json({"ok": True})
                return
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                db.execute(
                    "INSERT INTO portal_agent_events(id, user_id, event_type, screen, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (secrets.token_hex(16), user["id"], event_type, screen, text, now_iso()),
                )
                db.execute(
                    "DELETE FROM portal_agent_events WHERE created_at < datetime('now', '-30 days')"
                )
                db.commit()
            self.send_json({"ok": True})
            return
        if path == "/api/cobranca/grupos":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode alterar as cópias por grupo."}, 403)
                    return
                _, ignored = cobranca_group_cc_save(db, payload.get("groups"))
                db.commit()
                data = cobranca_group_cc_public(db)
            self.send_json({"ok": True, "groups": data["groups"], "ignored": ignored})
            return
        if path == "/api/cobranca/email-config":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            try:
                port = int(payload.get("port") or 587)
            except (TypeError, ValueError):
                port = 0
            if not 1 <= port <= 65535:
                self.send_json({"error": "A porta do servidor de e-mail é inválida."}, 400)
                return
            password = payload.get("password")
            host = str(payload.get("host") or "").strip()[:160]
            from_email = str(payload.get("fromEmail") or "").strip()[:160]
            if from_email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", from_email):
                self.send_json({"error": "O e-mail do remetente não parece válido."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode alterar a conta de e-mail de envio."}, 403)
                    return
                current = cobranca_smtp_config(db)
                keep_password = password in (None, "")
                config = {
                    "host": host,
                    "port": port,
                    "user": str(payload.get("user") or "").strip()[:160],
                    "fromName": str(payload.get("fromName") or "").strip()[:120],
                    "fromEmail": from_email,
                    "useTls": bool(payload.get("useTls", True)),
                    "password": (current.get("password") or "") if keep_password else str(password),
                }
                if not host or not from_email:
                    db.execute("DELETE FROM meta WHERE key = ?", (COBRANCA_SMTP_KEY,))
                    config = {}
                else:
                    db.execute(
                        "INSERT INTO meta(key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (COBRANCA_SMTP_KEY, json.dumps(config, ensure_ascii=False)),
                    )
            self.send_json({"ok": True, "config": cobranca_smtp_public(config)})
            return
        if path == "/api/cobranca/email-test":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            to = str(payload.get("to") or "").strip()[:160]
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", to):
                self.send_json({"error": "Informe um e-mail válido para receber o teste."}, 400)
                return
            cc, invalid_cc = cobranca_parse_cc(payload, to)
            if invalid_cc:
                self.send_json({
                    "error": "Cópia inválida: " + ", ".join(invalid_cc[:3]) + ". Corrija os endereços de cópia."
                }, 400)
                return
            sample_key = str(payload.get("key") or "").strip()[:200]
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode enviar o teste da conta de e-mail."}, 403)
                    return
                config = cobranca_smtp_config(db)
                graph = cobranca_graph_config(db)
                company = cobranca_company_detail(db, sample_key) if sample_key else None
                if company is None or not company.get("casosCobrar"):
                    placeholders = ",".join("?" for _ in COBRANCA_ACTIVE_STATUSES)
                    row = db.execute(
                        f"SELECT * FROM cobranca_cases WHERE status IN ({placeholders}) "
                        "ORDER BY vencimento ASC LIMIT 1",
                        COBRANCA_ACTIVE_STATUSES,
                    ).fetchone()
                    company = cobranca_company_detail(db, cobranca_company_key_for_row(row)) if row else None
                if company is not None and not company.get("casosCobrar"):
                    company = None
                sample = cobranca_company_message(company) if company else None
            if sample:
                # O teste usa exatamente o assunto e o HTML que a empresa receberia.
                subject = sample["subject"]
                text_body = sample["text"]
                html_body = sample["html"]
                sample_name = company["nome"]
            else:
                subject = "Teste da cobrança em lote — Rede Saúde"
                text_body = (
                    "Este é um teste da conta de e-mail usada pelo portal para a cobrança em lote.\n"
                    "Se você recebeu esta mensagem, o envio está funcionando."
                )
                html_body = ""
                sample_name = ""
            smtp_ready = bool(config.get("host") and config.get("fromEmail"))
            graph_ready = bool(graph.get("refreshToken"))
            if not smtp_ready and not graph_ready:
                self.send_json({
                    "error": "Conecte a conta Microsoft do faturamento ou salve a conta SMTP antes de enviar o teste."
                }, 400)
                return
            test_channel = "smtp" if (smtp_ready and not graph_ready) else "graph"
            provider_ref = ""
            try:
                # A conexão Microsoft tem prioridade; o SMTP fica como reserva.
                if smtp_ready and not graph_ready:
                    message = EmailMessage()
                    message["Subject"] = subject
                    message["From"] = formataddr((config.get("fromName") or "Rede Saúde", config["fromEmail"]))
                    message["To"] = to
                    if cc:
                        message["Cc"] = ", ".join(cc)
                    message["Reply-To"] = config["fromEmail"]
                    message["Message-ID"] = make_msgid(
                        domain=str(config.get("fromEmail") or "").split("@")[-1] or None
                    )
                    message.set_content(text_body)
                    if html_body:
                        message.add_alternative(html_body, subtype="html")
                    provider_ref = str(message["Message-ID"] or "")
                    server = cobranca_smtp_connect(config)
                    try:
                        server.send_message(message)
                    finally:
                        try:
                            server.quit()
                        except Exception:
                            pass
                else:
                    with connection() as db:
                        token = cobranca_graph_access_token(db, graph)
                    provider_ref = cobranca_graph_send(
                        token, to, subject, html_body or text_body,
                        str(graph.get("account") or ""),
                        "HTML" if html_body else "Text", cc,
                    ) or ""
            except Exception as exc:
                with connection() as db:
                    cobranca_send_log(
                        db, kind="teste", company=company, email=to, cc=cc,
                        cases=0, value=0, channel=test_channel,
                        status="falha", error=str(exc), user=user,
                    )
                self.send_json({"error": f"Não foi possível enviar o teste: {exc}"}, 502)
                return
            with connection() as db:
                cobranca_send_log(
                    db, kind="teste", company=company, email=to, cc=cc,
                    cases=0, value=0, channel=test_channel,
                    status="enviado", provider_ref=provider_ref, user=user,
                )
            self.send_json({
                "ok": True,
                "to": to,
                "cc": cc,
                "subject": subject,
                "company": sample_name,
            })
            return
        if path == "/api/cobranca/graph/start":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode conectar a conta Microsoft."}, 403)
                    return
            status, data = cobranca_graph_device_start()
            if status >= 400 or not data.get("device_code"):
                detail = data.get("error_description") or data.get("error") or "sem resposta"
                self.send_json({
                    "error": f"Não foi possível iniciar a conexão com a Microsoft: {str(detail)[:240]}"
                }, 502)
                return
            self.send_json({
                "ok": True,
                "userCode": data.get("user_code") or "",
                "verificationUri": data.get("verification_uri") or "https://microsoft.com/devicelogin",
                "deviceCode": data.get("device_code") or "",
                "expiresIn": int(data.get("expires_in") or 900),
                "interval": max(3, int(data.get("interval") or 5)),
            })
            return
        if path == "/api/cobranca/graph/poll":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            device_code = str(payload.get("deviceCode") or "").strip()
            if not device_code:
                self.send_json({"error": "Gere um novo código para conectar a conta Microsoft."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode conectar a conta Microsoft."}, 403)
                    return
            status, token = cobranca_graph_token_request({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": COBRANCA_GRAPH_CLIENT_ID,
                "device_code": device_code,
            })
            if status >= 400 or not token.get("access_token"):
                name = str(token.get("error") or "")
                if name == "authorization_pending":
                    self.send_json({"ok": True, "pending": True})
                    return
                if name == "slow_down":
                    self.send_json({"ok": True, "pending": True, "slowDown": True})
                    return
                if name == "expired_token":
                    self.send_json({
                        "error": "O código expirou. Clique em Conectar conta Microsoft para gerar outro."
                    }, 400)
                    return
                detail = token.get("error_description") or name or "sem resposta"
                self.send_json({"error": f"A Microsoft recusou a conexão: {str(detail)[:300]}"}, 502)
                return
            refresh = str(token.get("refresh_token") or "")
            if not refresh:
                self.send_json({
                    "error": "A Microsoft não devolveu o acesso permanente. Tente conectar de novo."
                }, 502)
                return
            config = {
                "refreshToken": refresh,
                "account": cobranca_graph_account(token),
                "connectedAt": now_iso(),
            }
            with connection() as db:
                if not config["account"]:
                    config["account"] = str(cobranca_smtp_config(db).get("fromEmail") or "")
                cobranca_graph_save(db, config)
            self.send_json({"ok": True, "graph": cobranca_graph_public(config)})
            return
        if path == "/api/cobranca/graph/disconnect":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode desconectar a conta Microsoft."}, 403)
                    return
                db.execute("DELETE FROM meta WHERE key = ?", (COBRANCA_GRAPH_KEY,))
            self.send_json({"ok": True})
            return
        if path == "/api/cobranca/empresa/send":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            key = str(payload.get("key") or "").strip()
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                company = cobranca_company_detail(db, key)
                if not company:
                    self.send_json({"error": "Empresa não encontrada na fila de cobrança."}, 404)
                    return
                if company["bloqueada"]:
                    self.send_json({"error": company["motivo"] or "Esta empresa não pode ser cobrada."}, 400)
                    return
                if not company["casosCobrar"]:
                    self.send_json({"error": "Esta empresa não tem títulos em aberto para cobrar."}, 400)
                    return
                if any(
                    str(item.get("lastContactAt") or "")[:10] == date.today().isoformat()
                    for item in company.get("casos") or []
                ):
                    self.send_json({
                        "error": "Esta empresa já recebeu uma cobrança hoje. O envio foi bloqueado para evitar duplicidade."
                    }, 409)
                    return
                to_email = str(payload.get("to") or "").strip()
                if not to_email:
                    to_email = company["emails"][0] if company["emails"] else ""
                if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", to_email):
                    self.send_json({"error": "Informe um e-mail válido para o envio."}, 400)
                    return
                if cobranca_email_is_internal(to_email):
                    self.send_json({"error": "Esse e-mail é interno da Rede Saúde e não recebe cobrança."}, 400)
                    return
                cc = [value for value in (company.get("cc") or []) if value and value != to_email]
                config = cobranca_smtp_config(db)
                graph = cobranca_graph_config(db)
                smtp_ready = bool(config.get("host") and config.get("fromEmail"))
                graph_ready = bool(graph.get("refreshToken"))
                if not smtp_ready and not graph_ready:
                    self.send_json({
                        "error": "Conecte a conta Microsoft do faturamento ou configure o SMTP antes de enviar.",
                        "needsEmailConfig": True,
                    }, 400)
                    return
                message_data = cobranca_company_message(company)
                subject = str(payload.get("subject") or message_data["subject"]).strip()[:200] or message_data["subject"]
                channel = "graph" if graph_ready else "smtp"
                provider_ref = ""
                claim_key = cobranca_send_claim_key(company)
                if not cobranca_claim_send(claim_key):
                    self.send_json({
                        "error": "Esta empresa já está em outro envio. Aguarde a conclusão antes de tentar novamente."
                    }, 409)
                    return
                try:
                    if graph_ready:
                        graph_token = cobranca_graph_access_token(db, graph)
                        db.commit()
                        provider_ref = cobranca_graph_send(
                            graph_token, to_email, subject,
                            message_data["html"], str(graph.get("account") or ""), "HTML", cc,
                        ) or ""
                    else:
                        server = cobranca_smtp_connect(config)
                        try:
                            message = EmailMessage()
                            message["Subject"] = subject
                            message["From"] = formataddr((config.get("fromName") or "Rede Saúde", config["fromEmail"]))
                            message["To"] = to_email
                            if cc:
                                message["Cc"] = ", ".join(cc)
                            message["Reply-To"] = config["fromEmail"]
                            message["Message-ID"] = make_msgid(
                                domain=str(config.get("fromEmail") or "").split("@")[-1] or None
                            )
                            message.set_content(message_data["text"])
                            message.add_alternative(message_data["html"], subtype="html")
                            provider_ref = str(message["Message-ID"] or "")
                            server.send_message(message)
                        finally:
                            try:
                                server.quit()
                            except Exception:
                                pass
                except Exception as exc:
                    cobranca_send_log(
                        db, kind="empresa", company=company, email=to_email, cc=cc,
                        cases=company["casesCobrar"], value=company["totalCobrar"],
                        channel=channel, status="falha", error=str(exc), user=user,
                    )
                    db.commit()
                    cobranca_release_send(claim_key)
                    self.send_json({"error": f"Não foi possível enviar o e-mail: {exc}"}, 502)
                    return
                cobranca_lote_mark(db, user, company)
                cobranca_send_log(
                    db, kind="empresa", company=company, email=to_email, cc=cc,
                    cases=company["casesCobrar"], value=company["totalCobrar"],
                    channel=channel, status="enviado", provider_ref=provider_ref, user=user,
                )
                db.commit()
                cobranca_release_send(claim_key)
                sender = str(graph.get("account") or config.get("fromEmail") or "")
            self.send_json({
                "ok": True,
                "sent": 1,
                "to": to_email,
                "cc": cc,
                "sender": sender,
                "cases": company["casesCobrar"],
                "value": company["totalCobrar"],
                "subject": subject,
            })
            return
        if path == "/api/cobranca/lote":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            dry_run = payload.get("dryRun", True) is not False
            skip_today = payload.get("skipToday", True) is not False
            skip_due_today = payload.get("skipDueToday", True) is not False
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                query = parse_qs(urlparse(self.path).query)
                where, params = cobranca_filters_from_query(query)
                where, params = cobranca_company_search_filter(db, where, params, query)
                plan = cobranca_lote_plan(db, skip_today, where, params, skip_due_today)
                config = cobranca_smtp_config(db)
                graph = cobranca_graph_config(db)
                if dry_run:
                    facets = cobranca_facet_payload(db, query)
                    self.send_json({
                        "ok": True,
                        "dryRun": True,
                        "plan": cobranca_lote_public(plan),
                        "email": cobranca_smtp_public(config),
                        "graph": cobranca_graph_public(graph),
                        "tipos": facets["tipos"],
                        "groups": facets["groups"],
                        "canManage": is_manager(user),
                    })
                    return
                smtp_ready = bool(config.get("host") and config.get("fromEmail"))
                graph_ready = bool(graph.get("refreshToken"))
                if not smtp_ready and not graph_ready:
                    self.send_json({
                        "error": "Conecte a conta Microsoft do faturamento ou configure o SMTP antes de cobrar em lote.",
                        "needsEmailConfig": True,
                    }, 400)
                    return
                selection = payload.get("companies")
                skipped_selection = 0
                if isinstance(selection, list):
                    if len(selection) > COBRANCA_LOTE_LIMIT:
                        self.send_json({
                            "error": f"Selecione até {COBRANCA_LOTE_LIMIT} empresas por envio."
                        }, 400)
                        return
                    by_key = {item["key"]: item for item in plan["companies"]}
                    companies = []
                    selected_keys = set()
                    for entry in selection:
                        if not isinstance(entry, dict):
                            skipped_selection += 1
                            continue
                        company_key = str(entry.get("key") or "").strip()
                        if not company_key or company_key in selected_keys:
                            skipped_selection += 1
                            continue
                        company = by_key.get(company_key)
                        email = str(entry.get("email") or "").strip()
                        if company is None or not company["casosCobrar"]:
                            skipped_selection += 1
                            continue
                        email = email or company["email"]
                        if not cobranca_email_is_valid(email) or cobranca_email_is_internal(email):
                            skipped_selection += 1
                            continue
                        if skip_today and company.get("cobradoHoje"):
                            skipped_selection += 1
                            continue
                        selected_keys.add(company_key)
                        company = dict(company)
                        company["email"] = email
                        companies.append(company)
                else:
                    companies = [
                        item for item in plan["companies"]
                        if item["temEmail"] and not (skip_today and item.get("cobradoHoje"))
                    ][:COBRANCA_LOTE_LIMIT]
                if not companies:
                    self.send_json({"error": "Nenhuma empresa selecionada com e-mail para cobrar agora."}, 400)
                    return
                server = None
                graph_token = ""
                graph_sender = str(graph.get("account") or "")
                if smtp_ready and not graph_ready:
                    try:
                        server = cobranca_smtp_connect(config)
                    except Exception as exc:
                        self.send_json({"error": f"Não foi possível conectar ao servidor de e-mail: {exc}"}, 502)
                        return
                else:
                    try:
                        graph_token = cobranca_graph_access_token(db, graph)
                        # O token de renovação muda a cada uso; confirma antes de enviar.
                        db.commit()
                    except Exception as exc:
                        self.send_json({"error": f"Não foi possível entrar na conta Microsoft: {exc}"}, 502)
                        return
                sent = []
                failures = []
                claimed_keys = set()
                try:
                    for company in companies:
                        claim_key = cobranca_send_claim_key(company)
                        if not cobranca_claim_send(claim_key):
                            failures.append({
                                "cliente": company["nome"],
                                "email": company["email"],
                                "error": "Esta empresa já está em outro envio.",
                            })
                            continue
                        claimed_keys.add(claim_key)
                        message_data = cobranca_company_message(company)
                        subject = message_data["subject"]
                        cc = [value for value in (company.get("cc") or []) if value and value != company["email"]]
                        try:
                            provider_ref = ""
                            if server is not None:
                                message = EmailMessage()
                                message["Subject"] = subject
                                message["From"] = formataddr((config.get("fromName") or "Rede Saúde", config["fromEmail"]))
                                message["To"] = company["email"]
                                if cc:
                                    message["Cc"] = ", ".join(cc)
                                message["Reply-To"] = config["fromEmail"]
                                message["Message-ID"] = make_msgid(
                                    domain=str(config.get("fromEmail") or "").split("@")[-1] or None
                                )
                                message.set_content(message_data["text"])
                                message.add_alternative(message_data["html"], subtype="html")
                                provider_ref = str(message["Message-ID"] or "")
                                server.send_message(message)
                            else:
                                try:
                                    provider_ref = cobranca_graph_send(
                                        graph_token, company["email"], subject,
                                        message_data["html"], graph_sender, "HTML", cc,
                                    ) or ""
                                except CobrancaGraphError as exc:
                                    if exc.status != 401:
                                        raise
                                    graph_token = cobranca_graph_access_token(db, graph)
                                    db.commit()
                                    provider_ref = cobranca_graph_send(
                                        graph_token, company["email"], subject,
                                        message_data["html"], graph_sender, "HTML", cc,
                                    ) or ""
                        except Exception as exc:
                            failures.append({
                                "cliente": company["nome"],
                                "email": company["email"],
                                "error": str(exc)[:200],
                            })
                            cobranca_send_log(
                                db, kind="lote", company=company, email=company["email"], cc=cc,
                                cases=company["casesCobrar"], value=company["totalCobrar"],
                                channel="smtp" if server is not None else "graph",
                                status="falha", error=str(exc), user=user,
                            )
                            db.commit()
                            continue
                        sent.append(company)
                        cobranca_lote_mark(db, user, company)
                        cobranca_send_log(
                            db, kind="lote", company=company, email=company["email"], cc=cc,
                            cases=company["casesCobrar"], value=company["totalCobrar"],
                            channel="smtp" if server is not None else "graph",
                            status="enviado", provider_ref=provider_ref, user=user,
                        )
                        # Libera a trava do banco entre os envios para o portal seguir funcionando.
                        db.commit()
                finally:
                    for company_key in claimed_keys:
                        cobranca_release_send(company_key)
                    if server is not None:
                        try:
                            server.quit()
                        except Exception:
                            pass
                remaining = max(0, plan["totalEmpresas"] - len(companies))
                response = {
                    "ok": True,
                    "dryRun": False,
                    "sent": len(sent),
                    "failed": len(failures),
                    "cases": sum(company["casesCobrar"] for company in sent),
                    "value": round(sum(company["totalCobrar"] for company in sent), 2),
                    "failures": failures[:20],
                    "remaining": remaining,
                    "skipped": {
                        "deposito": plan["depositoCasos"],
                        "cancelada": plan["canceladaCasos"],
                        "semEmail": plan["semEmail"],
                        "cobradosHoje": plan["cobradosHoje"],
                        "vencendoHoje": plan["vencendoHojeCasos"] if skip_due_today else 0,
                        "selecao": skipped_selection,
                    },
                }
                self.send_json(response)
                return
        if path == "/api/s4e/connect":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            save_account = bool(payload.get("save"))
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if save_account and not is_manager(user):
                    self.send_json({"error": "Só a gerência pode salvar a conta do S4E no portal."}, 403)
                    return
            cpf = re.sub(r"\D", "", str(payload.get("cpf") or ""))
            password = str(payload.get("password") or "")
            try:
                if save_account:
                    protected = protect_secret(password)
                    if not protected:
                        raise s4e.ConnectorError("Não foi possível proteger a senha neste servidor.")
                status = s4e.connect(cpf, password)
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except OSError:
                self.send_json({"error": "Não foi possível proteger a senha neste computador."}, 400)
                return
            finally:
                payload["password"] = ""
                password = ""
            account = {}
            if save_account:
                with connection() as db:
                    config = s4e_account_save(
                        db, cpf, protected,
                        status.get("user") or "", user["display_name"] or user["username"],
                    )
                    account = s4e_account_public(config)
            self.send_json({"ok": True, **status, "account": account})
            return
        if path == "/api/s4e/account/delete":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Só a gerência pode remover a conta do S4E."}, 403)
                    return
                s4e_account_delete(db)
            self.send_json({"ok": True, **s4e.disconnect(), "account": s4e_account_public({})})
            return
        if path == "/api/s4e/disconnect":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
            self.send_json({"ok": True, **s4e.disconnect()})
            return
        if path == "/api/vendas/consultar":
            with connection() as db:
                if not require_admin(db, self):
                    return
            try:
                start, end = vendas.period(read_json(self))
                vendas.start_query(start, end)
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"job": vendas.job_status()}, 202)
            return
        if path == "/api/vidas/atualizar":
            with connection() as db:
                if not require_vidas(db, self):
                    return
            try:
                start, end = vendas.period(read_json(self))
                vendas.start_query(start, end)
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"job": vendas.job_status()}, 202)
            return
        if path == "/api/semanal/atualizar":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie o período em JSON."}, 400)
                return
            with connection() as db:
                if not require_weekly(db, self):
                    return
            try:
                start, end = relatorio_semanal.period(payload)
                relatorio_semanal.start_sync(start, end, bool(payload.get("force")))
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"job": relatorio_semanal.job_status()}, 202)
            return
        if path == "/api/vidas/pessoas/sincronizar":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_vidas(db, self)
                if not user:
                    return
            try:
                start, end = vendas.period(payload)
                vidas.start_sync(start, end, str(payload.get("escopo") or "all"),
                                 user["display_name"] or user["username"])
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"job": vidas.job_status()}, 202)
            return
        if path == "/api/notas/conferir":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie o período em JSON."}, 400)
                return
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
            try:
                start, end = s4e_notas.parse_period(payload)
                s4e_notas.start_run(start, end, user["display_name"] or user["username"])
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"job": s4e_notas.job_status()}, 202)
            return
        if path == "/api/vidas/importacoes/remover":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            import_id = str(payload.get("id") or "").strip()
            if not import_id:
                self.send_json({"error": "Informe a importação que deve ser removida."}, 400)
                return
            with connection() as db:
                if not require_admin(db, self):
                    return
                removed = vidas.remove_import(db, import_id)
                if not removed:
                    self.send_json({"error": "Importação não encontrada."}, 404)
                    return
                result = vidas.people(db)
            self.send_json({"ok": True, "pessoas": result})
            return
        if path == "/api/retornos/sync":
            with connection() as db:
                if not require_retornos(db, self):
                    return
            try:
                start, end = retornos.period(read_json(self))
                retornos.start_sync(start, end)
            except (ValueError, TypeError) as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            with connection() as db:
                state = retornos.monitor(db)
            self.send_json({"monitor": state}, 202)
            return
        if path == "/api/s4e/import":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                snapshot = {
                    "id": user["id"],
                    "display_name": user["display_name"],
                    "username": user["username"],
                }
            try:
                job_id = s4e.start_import(
                    {
                        "periodStart": payload.get("periodStart") or "",
                        "periodEnd": payload.get("periodEnd") or "",
                        "withContacts": bool(payload.get("withContacts")),
                        "dryRun": bool(payload.get("dryRun")),
                    },
                    lambda rows, **kwargs: s4e_import_into_cobranca(snapshot, rows, **kwargs),
                )
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"ok": True, "jobId": job_id})
            return
        if path == "/api/rateios-faturamento/regras":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente a administração pode salvar regras."}, 403)
                    return
                group = str(payload.get("grupo") or "").strip()[:200]
                group_company = str(payload.get("grupoEmpresa") or "").strip()[:200]
                company = str(payload.get("empresa") or "").strip()[:250]
                receiver = str(payload.get("recebedor") or "").strip()[:120]
                method = str(payload.get("metodo") or "por_vida")
                if not group or not receiver or method not in {"por_vida", "percentual", "fixo"}:
                    self.send_json({"error": "Informe grupo, recebedor e método válidos."}, 400)
                    return
                try:
                    value = float(payload.get("valor"))
                except (TypeError, ValueError):
                    self.send_json({"error": "Informe um valor numérico."}, 400)
                    return
                if value < 0:
                    self.send_json({"error": "O valor não pode ser negativo."}, 400)
                    return
                active = 1 if payload.get("ativo", True) else 0
                stamp = now_iso()
                rule_id = str(payload.get("id") or "").strip()
                if rule_id:
                    db.execute("UPDATE rateio_rules SET grupo=?, grupo_empresa=?, empresa=?, recebedor=?, metodo=?, valor=?, ativo=?, vigencia_inicio=?, vigencia_fim=?, updated_at=? WHERE id=?", (group, group_company, company, receiver, method, value, active, str(payload.get("vigenciaInicio") or ""), str(payload.get("vigenciaFim") or ""), stamp, rule_id))
                else:
                    db.execute("INSERT INTO rateio_rules(id, grupo, grupo_empresa, empresa, recebedor, metodo, valor, ativo, vigencia_inicio, vigencia_fim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), group, group_company, company, receiver, method, value, active, str(payload.get("vigenciaInicio") or ""), str(payload.get("vigenciaFim") or ""), stamp, stamp))
                db.commit()
            self.send_json({"ok": True})
            return
        if path == "/api/apuracao/run":
            try:
                payload = read_json(self)
                if not isinstance(payload, dict):
                    raise ValueError("Objeto JSON esperado")
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            competencia = str(payload.get("competencia") or "").strip()
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
            try:
                run_id = apuracao_start_run(competencia, mode="manual", user_name=user["display_name"])
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"ok": True, "runId": run_id, "job": apuracao_job_status()})
            return
        if path == "/api/recibos/run":
            try:
                payload = read_json(self)
                if not isinstance(payload, dict):
                    raise ValueError("Objeto JSON esperado")
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_recibos(db, self)
                if not user:
                    return
            try:
                run_id = recibos_start_run(
                    payload.get("start") or "",
                    payload.get("end") or "",
                    centro=str(payload.get("centro") or "").strip(),
                    grupo=str(payload.get("grupo") or "").strip(),
                    user_name=user["display_name"],
                )
            except s4e.ConnectorError as exc:
                self.send_json({"error": str(exc)}, 409)
                return
            self.send_json({"ok": True, "runId": run_id, "job": recibos_job_status()})
            return
        if path == "/api/apuracao/mapa":
            try:
                payload = read_json(self)
                if not isinstance(payload, dict):
                    raise ValueError("Objeto JSON esperado")
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente o administrador pode editar o mapeamento."}, 403)
                    return
                apuracao_seed_map(db)
                grupo = str(payload.get("grupo") or "").strip()
                tipo = str(payload.get("tipoPagamento") or "").strip()
                mae = str(payload.get("grupoMae") or "").strip()
                if not grupo or not mae:
                    self.send_json({"error": "Informe o grupo de empresa e o grupo-mãe."}, 400)
                    return
                existing = next((item for item in db.execute(
                    "SELECT id, grupo, tipo_pagamento FROM apuracao_map"
                ) if _apuracao_norm(item["grupo"]) == _apuracao_norm(grupo)
                    and _apuracao_norm(item["tipo_pagamento"]) == _apuracao_norm(tipo)), None)
                if existing:
                    db.execute(
                        "UPDATE apuracao_map SET grupo_mae = ? WHERE id = ?", (mae, existing["id"])
                    )
                else:
                    db.execute(
                        "INSERT INTO apuracao_map(id, grupo, tipo_pagamento, grupo_mae) VALUES (?, ?, ?, ?)",
                        (str(uuid.uuid4()), grupo, tipo, mae),
                    )
                db.commit()
            self.send_json({"ok": True})
            return
        if path == "/api/adesoes":
            try:
                payload = read_json(self)
                if not isinstance(payload, dict):
                    raise ValueError("Objeto JSON esperado")
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
                
                adesao_id = str(uuid.uuid4())
                lote = str(payload.get("lote") or "").strip()
                empresa = str(payload.get("empresa") or "").strip()
                data_entrada = str(payload.get("dataEntrada") or "").strip()
                data_adesao = str(payload.get("dataAdesao") or "").strip() or now_iso()[:10]
                vidas = payload.get("vidas")
                valor = payload.get("valor")
                tipo = str(payload.get("tipo") or "WEB").strip().upper()
                situacao = str(payload.get("situacao") or "ativo").strip()
                
                if not lote or not empresa or not data_entrada:
                    self.send_json({"error": "Lote, empresa e data de entrada são obrigatórios."}, 400)
                    return
                
                if tipo not in ("WEB", "CRM"):
                    tipo = "WEB"
                
                try:
                    vidas_int = int(vidas) if vidas else 0
                except (ValueError, TypeError):
                    vidas_int = 0
                
                try:
                    valor_real = float(valor) if valor else 0.0
                except (ValueError, TypeError):
                    valor_real = 0.0
                
                db.execute(
                    """INSERT INTO adesoes(id, lote, empresa, data_entrada, vidas, valor, tipo, situacao, 
                    conferencia_status, data_adesao, criado_em, atualizado_em)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (adesao_id, lote, empresa, data_entrada, vidas_int, valor_real, tipo, situacao, 
                     "pendente", data_adesao, now_iso(), now_iso())
                )
                db.commit()
                
                self.send_json({"id": adesao_id, "success": True}, 201)
            return
        if path == "/api/adesoes/conferir":
            path_parts = urlparse(self.path).path.split("/")
            if len(path_parts) >= 5 and path_parts[4]:
                adesao_id = unquote(path_parts[4]).strip()
            else:
                self.send_json({"error": "ID da adesão não informado."}, 400)
                return
            
            try:
                payload = read_json(self)
                if not isinstance(payload, dict):
                    raise ValueError("Objeto JSON esperado")
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
                
                adesao = db.execute("SELECT * FROM adesoes WHERE id = ?", (adesao_id,)).fetchone()
                if not adesao:
                    self.send_json({"error": "Adesão não encontrada."}, 404)
                    return
                
                from adesoes_validation import validate_adesao_with_s4e
                
                # Obtém sessão S4E para verificação de empresa
                try:
                    http_session = s4e.ensure_session()
                except Exception:
                    http_session = None
                
                validation = validate_adesao_with_s4e(
                    adesao["lote"],
                    adesao["empresa"],
                    adesao["data_entrada"],
                    adesao["vidas"] or 0,
                    http_session=http_session
                )
                
                resultado = {
                    "validation": validation,
                    "timestamp": now_iso()
                }
                
                # Status logic: valid+no_warnings → validado, valid+warnings → alerta, else → erro
                status_conferencia = "validado" if (validation["valid"] and not validation["warnings"]) else ("alerta" if (validation["valid"] and validation["warnings"]) else "erro")
                notas = payload.get("notas", "")
                
                db.execute(
                    """UPDATE adesoes SET conferencia_status = ?, conferencia_resultado = ?, 
                    notas_conferencia = ?, conferido_em = ?, conferido_por = ?, atualizado_em = ?
                    WHERE id = ?""",
                    (status_conferencia, json.dumps(resultado, ensure_ascii=False), notas, now_iso(), user["id"], now_iso(), adesao_id)
                )
                db.commit()
                
                self.send_json({
                    "id": adesao_id,
                    "statusConferencia": status_conferencia,
                    "notasConferencia": notas,
                    "conferidoEm": now_iso()
                })
            return
        if path == "/api/adesoes/conferir-todos":
            query = parse_qs(urlparse(self.path).query)
            mes = (query.get("mes") or [""])[0].strip()
            ano = (query.get("ano") or [""])[0].strip()
            
            def run_batch_reconciliation():
                """Executa a reconciliação em background com progresso."""
                from adesoes_validation import validate_adesao_with_s4e
                
                # Obtém sessão S4E uma vez para reutilizar
                try:
                    http_session = s4e.ensure_session()
                except Exception:
                    http_session = None
                
                with connection() as db:
                    user_record = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
                    
                    where_parts = []
                    params = []
                    
                    if mes and ano:
                        try:
                            mes_int = int(mes)
                            ano_int = int(ano)
                            if 1 <= mes_int <= 12 and 1000 <= ano_int <= 9999:
                                start = f"{ano_int:04d}-{mes_int:02d}-01"
                                if mes_int == 12:
                                    end = f"{ano_int+1:04d}-01-01"
                                else:
                                    end = f"{ano_int:04d}-{mes_int+1:02d}-01"
                                where_parts.append("data_adesao >= ? AND data_adesao < ?")
                                params.extend([start, end])
                        except (ValueError, TypeError):
                            pass
                    
                    where_clause = " WHERE " + " AND ".join(where_parts) if where_parts else ""
                    rows = db.execute(f"SELECT id FROM adesoes {where_clause}", params).fetchall()
                    
                    total = len(rows)
                    processados = 0
                    conferidos = 0
                    alertas = 0
                    problemas = 0
                    
                    for idx, row in enumerate(rows):
                        adesao = db.execute("SELECT * FROM adesoes WHERE id = ?", (row["id"],)).fetchone()
                        if not adesao:
                            continue
                        
                        # Valida com S4E se disponível
                        validation = validate_adesao_with_s4e(
                            adesao["lote"],
                            adesao["empresa"],
                            adesao["data_entrada"],
                            adesao["vidas"] or 0,
                            http_session=http_session
                        )
                        
                        resultado = {
                            "validation": validation,
                            "timestamp": now_iso()
                        }
                        
                        if validation["valid"] and not validation["warnings"]:
                            status = "validado"
                            conferidos += 1
                        elif validation["errors"]:
                            status = "erro"
                            problemas += 1
                        else:
                            status = "alerta"
                            alertas += 1
                        
                        db.execute(
                            """UPDATE adesoes SET conferencia_status = ?, conferencia_resultado = ?, 
                            conferido_em = ?, conferido_por = ?, atualizado_em = ?
                            WHERE id = ?""",
                            (status, json.dumps(resultado, ensure_ascii=False), now_iso(), user["id"], now_iso(), adesao["id"])
                        )
                        processados += 1
                        
                        # Commit a cada 10 registros para evitar lock prolongado
                        if processados % 10 == 0:
                            db.commit()
                    
                    db.commit()
                    
                    return {
                        "processados": processados,
                        "conferidos": conferidos,
                        "alertas": alertas,
                        "problemas": problemas
                    }
            
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
                
                # Roda reconciliação em thread para não bloquear
                executor = ThreadPoolExecutor(max_workers=1)
                future = executor.submit(run_batch_reconciliation)
                
                try:
                    result = future.result(timeout=600)  # Timeout de 10 minutos
                    self.send_json(result)
                except Exception as e:
                    self.send_json({
                        "error": f"Erro ao processar adesões: {str(e)[:100]}",
                        "processados": 0,
                        "conferidos": 0,
                        "alertas": 0,
                        "problemas": 0
                    }, 500)
                finally:
                    executor.shutdown(wait=False)
            return
        if path == "/api/cobranca/clear":
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente o administrador pode limpar a fila de cobrança."}, 403)
                    return
                job = s4e.status().get("job") or {}
                if job.get("running"):
                    self.send_json({"error": "A importação do S4E ainda está rodando. Aguarde terminar para limpar a fila."}, 409)
                    return
                cases = db.execute("SELECT COUNT(*) AS total FROM cobranca_cases").fetchone()["total"]
                imports = db.execute("SELECT COUNT(*) AS total FROM cobranca_imports").fetchone()["total"]
                db.execute("DELETE FROM cobranca_history")
                db.execute("DELETE FROM cobranca_cases")
                db.execute("DELETE FROM cobranca_imports")
                db.commit()
            self.send_json({"ok": True, "cases": cases, "imports": imports})
            return
        if path == "/api/cobranca/empresa/delete":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            key = str(payload.get("key") or "").strip()
            if not key:
                self.send_json({"error": "Informe a empresa que deve ser apagada."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente o administrador pode excluir uma cobrança."}, 403)
                    return
                rows = [
                    row for row in db.execute("SELECT * FROM cobranca_cases").fetchall()
                    if cobranca_company_key_for_row(row) == key
                ]
                if not rows:
                    self.send_json({"error": "Empresa não encontrada na fila de cobrança."}, 404)
                    return
                case_ids = [row["id"] for row in rows]
                placeholders = ",".join("?" for _ in case_ids)
                db.execute(f"DELETE FROM cobranca_history WHERE case_id IN ({placeholders})", case_ids)
                db.execute(f"DELETE FROM cobranca_cases WHERE id IN ({placeholders})", case_ids)
                db.commit()
            self.send_json({"ok": True, "cases": len(case_ids)})
            return
        if path == "/api/cobranca/import":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            rows = payload.get("rows")
            if not isinstance(rows, list) or not rows:
                self.send_json({"error": "Nenhuma cobrança foi recebida para importar."}, 400)
                return
            if len(rows) > 20000:
                self.send_json({"error": "O lote tem cobranças demais. Importe até 20.000 linhas por vez."}, 413)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                result = cobranca_import_rows(
                    db, user, rows,
                    source=str(payload.get("source") or "extensao")[:30],
                    period_start=payload.get("periodStart") or "",
                    period_end=payload.get("periodEnd") or "",
                    full_scope=bool(payload.get("fullScope")),
                )
            self.send_json({"ok": True, "import": result})
            return
        if path == "/api/cobranca/templates":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            name = str(payload.get("name") or "").strip()[:120]
            channel = str(payload.get("channel") or "").strip()
            body = str(payload.get("body") or "").strip()
            if not name or not body:
                self.send_json({"error": "Informe o nome e o texto do modelo."}, 400)
                return
            if channel not in ("email", "whatsapp"):
                self.send_json({"error": "Escolha o canal do modelo: e-mail ou WhatsApp."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                template_id = uuid.uuid4().hex
                db.execute(
                    "INSERT INTO cobranca_templates(id, name, channel, tipo, subject, body, active, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                    (
                        template_id, name, channel, str(payload.get("tipo") or "").strip().upper()[:40],
                        str(payload.get("subject") or "").strip()[:200], body, now_iso(),
                    ),
                )
                row = db.execute("SELECT * FROM cobranca_templates WHERE id = ?", (template_id,)).fetchone()
            self.send_json({"ok": True, "template": cobranca_template_payload(row)})
            return
        if path.startswith("/api/cobranca/") and path.endswith("/interaction"):
            case_id = unquote(path[len("/api/cobranca/"):-len("/interaction")]).strip("/")
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                case = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                if not case:
                    self.send_json({"error": "Cobrança não encontrada."}, 404)
                    return
                channel = str(payload.get("channel") or "").strip()
                if channel not in ("email", "whatsapp", "telefone", "sistema", "manual"):
                    self.send_json({"error": "Canal inválido."}, 400)
                    return
                result = str(payload.get("result") or "enviado").strip()
                if result not in COBRANCA_RESULT_LABELS:
                    result = "outro"
                next_contact = cobranca_date_iso(payload.get("nextContact"))
                status = str(payload.get("status") or "").strip()
                if status not in COBRANCA_STATUS_LABELS:
                    status = "promessa" if result == "prometeu" else "pago" if result == "pagou" else "em_cobranca"
                stamp = now_iso()
                count_contact = payload.get("count") is not False
                if count_contact:
                    db.execute(
                        "UPDATE cobranca_cases SET status = ?, last_contact_at = ?, next_contact = ?, "
                        "contact_count = contact_count + 1, "
                        "closed_at = CASE WHEN ? IN ('pago', 'encerrado') THEN ? ELSE closed_at END WHERE id = ?",
                        (status, stamp, next_contact or None, status, stamp, case_id),
                    )
                else:
                    db.execute(
                        "UPDATE cobranca_cases SET status = ?, next_contact = ?, "
                        "closed_at = CASE WHEN ? IN ('pago', 'encerrado') THEN ? ELSE closed_at END WHERE id = ?",
                        (status, next_contact or None, status, stamp, case_id),
                    )
                cobranca_log(
                    db, case_id, user, channel, result,
                    notes=str(payload.get("notes") or "").strip()[:2000],
                    next_contact=next_contact or None,
                    template_name=str(payload.get("templateName") or "").strip()[:120],
                )
                updated = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                history = db.execute(
                    "SELECT * FROM cobranca_history WHERE case_id = ? ORDER BY at DESC LIMIT 80", (case_id,)
                ).fetchall()
            self.send_json({
                "ok": True,
                "case": cobranca_case_payload(updated),
                "history": [cobranca_history_payload(row) for row in history],
            })
            return
        if path == "/api/finance/rateios/import":
            query = parse_qs(urlparse(self.path).query)
            file_name = unquote((query.get("name") or ["rateios.xlsx"])[0]).strip()[:160] or "rateios.xlsx"
            if not file_name.lower().endswith(".xlsx"):
                self.send_json({"error": "Envie o consolidado no formato .xlsx."}, 400)
                return
            force = (query.get("force") or ["0"])[0] in ("1", "true", "sim")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                self.send_json({"error": "O arquivo está vazio."}, 400)
                return
            if length > FINANCE_MAX_UPLOAD:
                self.send_json({"error": "O arquivo deve ter no máximo 80 MB."}, 413)
                return
            data = self.rfile.read(length)
            if len(data) != length:
                self.send_json({"error": "Envio incompleto. Tente novamente."}, 400)
                return
            try:
                parsed = finance_parse_workbook(data, file_name)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            file_hash = hashlib.sha256(data).hexdigest()
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                if not force:
                    existing = db.execute("SELECT * FROM finance_imports WHERE file_hash = ?", (file_hash,)).fetchone()
                    if existing:
                        self.send_json({
                            "error": "Este arquivo já foi importado. Confirme para substituir a importação anterior.",
                            "duplicate": True,
                            "import": finance_import_payload(existing),
                        }, 409)
                        return
                import_id, replaced = finance_store_import(db, parsed, file_name, file_hash, user)
                row = db.execute("SELECT * FROM finance_imports WHERE id = ?", (import_id,)).fetchone()
            self.send_json({
                "import": finance_import_payload(row),
                "replaced": bool(replaced),
                "ignoredSheets": parsed["ignoredSheets"],
                "sheets": parsed["sheets"],
            }, 201)
            return
        if path in ("/api/contracts/preview", "/api/contracts/import", "/api/commissions/preview", "/api/commissions/import"):
            commission_upload = path.startswith("/api/commissions/")
            query = parse_qs(urlparse(self.path).query)
            file_name = unquote((query.get("name") or ["planilha.xlsx"])[0]).strip()[:160] or "planilha.xlsx"
            if not file_name.lower().endswith(".xlsx"):
                self.send_json({"error": "Envie a planilha no formato .xlsx."}, 400)
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                self.send_json({"error": "O arquivo está vazio."}, 400)
                return
            if length > CONTRACT_MAX_UPLOAD:
                self.send_json({"error": "A planilha deve ter no máximo 12 MB."}, 413)
                return
            data = self.rfile.read(length)
            if len(data) != length:
                self.send_json({"error": "Envio incompleto. Tente novamente."}, 400)
                return
            try:
                parsed = contract_parse_xlsx(data)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            with connection() as db:
                user = require_commissions(db, self) if commission_upload else require_contracts(db, self)
                if not user:
                    return
                if commission_upload and not is_manager(user):
                    parsed["company"]["seller"] = user_seller_name(user)
                cnpj_key = digits_only(parsed["company"]["cnpj"])
                existing = None
                if cnpj_key:
                    existing = db.execute("SELECT * FROM contract_companies WHERE cnpj_key = ?", (cnpj_key,)).fetchone()
                if not existing:
                    existing = db.execute(
                        "SELECT * FROM contract_companies WHERE lower(trim(name)) = lower(trim(?))",
                        (parsed["company"]["name"],),
                    ).fetchone()
                if existing and commission_upload and not company_in_scope(existing, commission_scope(db, user)):
                    self.send_json({"error": "Essa empresa já está vinculada a outro vendedor."}, 403)
                    return
                existing_payload = None
                if existing:
                    lives_count = db.execute("SELECT COUNT(*) AS n FROM contract_lives WHERE company_id = ?", (existing["id"],)).fetchone()["n"]
                    existing_payload = {
                        "id": existing["id"],
                        "name": existing["name"],
                        "cnpj": existing["cnpj"],
                        "livesCount": lives_count,
                    }
                if path.endswith("/preview"):
                    company_preview = dict(parsed["company"])
                    if not (commission_upload or is_manager(user)):
                        company_preview["monthly_value"] = 0
                    self.send_json({
                        "company": company_preview,
                        "lives": parsed["lives"][:120],
                        "livesCount": len(parsed["lives"]),
                        "warnings": parsed["warnings"],
                        "existing": existing_payload,
                        "fileName": file_name,
                    })
                    return
                replace_lives = (query.get("replace") or ["0"])[0] in ("1", "true", "sim")
                result = contract_import(db, parsed, file_name, user, replace_lives)
                company, lives = contract_company_view(db, result["companyId"], commission_upload or is_manager(user))
            self.send_json({
                "company": company,
                "lives": lives,
                "imported": result,
                "warnings": parsed["warnings"],
                "fileName": file_name,
            }, 201)
            return
        if path == "/api/chat/upload":
            query = parse_qs(urlparse(self.path).query)
            kind = (query.get("kind") or [""])[0].strip()
            mime = (query.get("mime") or [""])[0].strip().lower()
            name = unquote((query.get("name") or [""])[0]).strip()[:160]
            suffix = "." + name.replace("\\", "/").rsplit("/", 1)[-1].rpartition(".")[2].lower() if "." in name else ""
            if kind == "file":
                if suffix not in DOC_EXTENSIONS:
                    self.send_json({"error": "Formato de arquivo não suportado."}, 400)
                    return
                if mime not in MEDIA_TYPES:
                    mime = "application/octet-stream"
            elif kind not in MEDIA_LIMITS or mime not in MEDIA_TYPES or MEDIA_TYPES[mime][0] != kind:
                self.send_json({"error": "Formato de arquivo não suportado."}, 400)
                return
            else:
                suffix = MEDIA_TYPES[mime][1]
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                self.send_json({"error": "Arquivo vazio."}, 400)
                return
            if length > MEDIA_LIMITS[kind]:
                limit_mb = MEDIA_LIMITS[kind] // 1_000_000
                self.send_json({"error": f"Arquivo maior que {limit_mb} MB para {kind}."}, 413)
                return
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
            data = self.rfile.read(length)
            if len(data) != length:
                self.send_json({"error": "Envio incompleto. Tente novamente."}, 400)
                return
            media_id = f"{uuid.uuid4()}{suffix}"
            (MEDIA_DIR / media_id).write_bytes(data)
            self.send_json({
                "media": f"/media/{media_id}",
                "mediaId": media_id,
                "mime": mime,
                "name": name or f"arquivo{suffix}",
                "size": length,
                "kind": kind,
            }, 201)
            return
        if path in ("/api/demands/upload", "/api/feed/upload"):
            query = parse_qs(urlparse(self.path).query)
            raw_name = unquote((query.get("name") or [""])[0]).strip()
            name = raw_name.replace("\\", "/").rsplit("/", 1)[-1][:200] or "arquivo"
            mime = (query.get("mime") or [""])[0].strip().lower()[:120] or "application/octet-stream"
            extension = ""
            if "." in name:
                candidate = "." + name.rpartition(".")[2].lower()
                if re.fullmatch(r"\.[a-z0-9]{1,10}", candidate):
                    extension = candidate
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                self.send_json({"error": "Arquivo vazio."}, 400)
                return
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
            media_id = f"{uuid.uuid4()}{extension}"
            target = MEDIA_DIR / media_id
            remaining = length
            try:
                with target.open("wb") as handle:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1_048_576, remaining))
                        if not chunk:
                            raise ValueError("Envio incompleto.")
                        handle.write(chunk)
                        remaining -= len(chunk)
            except (ValueError, OSError):
                target.unlink(missing_ok=True)
                self.send_json({"error": "Envio incompleto. Tente novamente."}, 400)
                return
            self.send_json({
                "media": f"/media/{media_id}",
                "mediaId": media_id,
                "mime": mime,
                "name": name,
                "size": length,
            }, 201)
            return
        try:
            payload = read_json(self)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "JSON inválido"}, 400)
            return
        if path == "/api/feed":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                body = str(payload.get("body") or "").strip()
                kind = str(payload.get("kind") or "post").strip().lower()
                if kind not in FEED_KINDS or kind == "digest":
                    kind = "post"
                if len(body) > 8000:
                    self.send_json({"error": "A publicação é muito longa."}, 400)
                    return
                media_items = []
                for item in payload.get("media") or []:
                    if not isinstance(item, dict):
                        continue
                    media = str(item.get("media") or "")
                    if not media.startswith("/media/"):
                        continue
                    if not (MEDIA_DIR / media.rpartition("/")[2]).is_file():
                        continue
                    try:
                        size = int(item.get("size") or 0)
                    except (TypeError, ValueError):
                        size = 0
                    media_items.append({
                        "media": media,
                        "mime": str(item.get("mime") or "application/octet-stream")[:120],
                        "name": str(item.get("name") or "arquivo")[:200],
                        "size": max(0, size),
                    })
                if not body and not media_items:
                    self.send_json({"error": "Escreva algo ou escolha uma foto para publicar."}, 400)
                    return
                post_id = str(uuid.uuid4())
                created_at = now_iso()
                db.execute(
                    "INSERT INTO feed_posts(id, author_id, kind, title, body, meta, created_at) VALUES (?, ?, ?, '', ?, '{}', ?)",
                    (post_id, user["id"], kind, body, created_at),
                )
                for item in media_items:
                    db.execute(
                        "INSERT INTO feed_media(id, post_id, media, mime, name, size) VALUES (?, ?, ?, ?, ?, ?)",
                        (str(uuid.uuid4()), post_id, item["media"], item["mime"], item["name"], item["size"]),
                    )
                db.commit()
                row = db.execute("SELECT * FROM feed_posts WHERE id = ?", (post_id,)).fetchone()
                view = feed_post_view(db, row, user)
            self.send_json({"post": view}, 201)
            return
        if path == "/api/feed/read":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                ids = db.execute("SELECT id FROM feed_posts").fetchall()
                stamp = now_iso()
                for row in ids:
                    db.execute(
                        "INSERT OR IGNORE INTO feed_reads(post_id, user_id, seen_at) VALUES (?, ?, ?)",
                        (row["id"], user["id"], stamp),
                    )
                db.commit()
            self.send_json({"unread": 0})
            return
        if path.startswith("/api/feed/") and path.endswith("/like"):
            post_id = unquote(path[len("/api/feed/"):-len("/like")]).strip("/")
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not db.execute("SELECT 1 FROM feed_posts WHERE id = ?", (post_id,)).fetchone():
                    self.send_json({"error": "Publicação não encontrada."}, 404)
                    return
                existing = db.execute(
                    "SELECT 1 FROM feed_likes WHERE post_id = ? AND user_id = ?",
                    (post_id, user["id"]),
                ).fetchone()
                if existing:
                    db.execute("DELETE FROM feed_likes WHERE post_id = ? AND user_id = ?", (post_id, user["id"]))
                    liked = False
                else:
                    db.execute(
                        "INSERT INTO feed_likes(post_id, user_id, created_at) VALUES (?, ?, ?)",
                        (post_id, user["id"], now_iso()),
                    )
                    liked = True
                db.commit()
                count = db.execute(
                    "SELECT COUNT(*) AS n FROM feed_likes WHERE post_id = ?",
                    (post_id,),
                ).fetchone()["n"]
            self.send_json({"liked": liked, "likes": count, "likers": feed_likers(db, post_id)})
            return
        if path.startswith("/api/feed/") and path.endswith("/comments"):
            post_id = unquote(path[len("/api/feed/"):-len("/comments")]).strip("/")
            body = str(payload.get("body") or "").strip()
            parent_id = str(payload.get("parentId") or "").strip()
            if not body:
                self.send_json({"error": "Escreva um comentário."}, 400)
                return
            if len(body) > 2000:
                self.send_json({"error": "O comentário é muito longo."}, 400)
                return
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not db.execute("SELECT 1 FROM feed_posts WHERE id = ?", (post_id,)).fetchone():
                    self.send_json({"error": "Publicação não encontrada."}, 404)
                    return
                if parent_id:
                    parent = db.execute(
                        "SELECT * FROM feed_comments WHERE id = ? AND post_id = ?",
                        (parent_id, post_id),
                    ).fetchone()
                    if not parent:
                        self.send_json({"error": "Comentário de origem não encontrado."}, 404)
                        return
                    parent_id = parent["parent_id"] or parent["id"]
                comment_id = str(uuid.uuid4())
                created_at = now_iso()
                db.execute(
                    "INSERT INTO feed_comments(id, post_id, author_id, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (comment_id, post_id, user["id"], body, parent_id or None, created_at),
                )
                db.commit()
                comment = {
                    "id": comment_id,
                    "parentId": parent_id or "",
                    "body": body,
                    "createdAt": created_at,
                    "author": feed_author_payload(user),
                    "canDelete": True,
                }
            self.send_json({"comment": comment}, 201)
            return
        if path == "/api/feed/notices/read":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                db.execute(
                    "UPDATE feed_notices SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL",
                    (now_iso(), user["id"]),
                )
                db.commit()
            self.send_json({"unread": 0})
            return
        if path == "/api/system-updates":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Apenas a administração pode publicar novidades do sistema."}, 403)
                    return
                title = str(payload.get("title") or "").strip()
                body = str(payload.get("body") or "").strip()
                if not title:
                    self.send_json({"error": "Informe o título da novidade."}, 400)
                    return
                if len(title) > 160 or len(body) > 2000:
                    self.send_json({"error": "Texto da novidade muito longo."}, 400)
                    return
                update_id = str(uuid.uuid4())
                created_at = now_iso()
                db.execute(
                    "INSERT INTO system_updates(id, title, body, created_at) VALUES (?, ?, ?, ?)",
                    (update_id, title, body, created_at),
                )
                db.commit()
                update = {"id": update_id, "title": title, "body": body, "createdAt": created_at}
            self.send_json({"update": update}, 201)
            return
        if path == "/api/commissions/companies":
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                try:
                    row = contract_create_company(db, payload, user)
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                db.commit()
                company = commission_company_payload(db, row)
            self.send_json({"company": company}, 201)
            return
        if path.startswith("/api/commissions/companies/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 5 and parts[4] == "movements":
                company_id = parts[3]
                with connection() as db:
                    user = require_commissions(db, self)
                    if not user:
                        return
                    company = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                    if not company:
                        self.send_json({"error": "Contrato não encontrado."}, 404)
                        return
                    if not company_in_scope(company, commission_scope(db, user)):
                        self.send_json({"error": "Você só pode lançar movimentações nos seus contratos."}, 403)
                        return
                    values = contract_movement_values(payload)
                    movement_id = str(uuid.uuid4())
                    now = now_iso()
                    db.execute(
                        """INSERT INTO contract_movements(
                            id, company_id, month_number, lives_added, value_per_life,
                            total_month, commission, note, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            movement_id, company_id, values["month_number"], values["lives_added"],
                            values["value_per_life"], values["total_month"], values["commission"],
                            values["note"], now, now,
                        ),
                    )
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (now, company_id))
                    db.commit()
                    row = db.execute("SELECT * FROM contract_movements WHERE id = ?", (movement_id,)).fetchone()
                self.send_json({"movement": contract_movement_payload(row)}, 201)
                return
        if path.startswith("/api/contracts/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[3] == "lives":
                company_id = parts[2]
                with connection() as db:
                    user, can_register = require_lives_access(db, self, company_id)
                    if not user:
                        return
                    if not db.execute("SELECT 1 FROM contract_companies WHERE id = ?", (company_id,)).fetchone():
                        self.send_json({"error": "Empresa não encontrada."}, 404)
                        return
                    try:
                        updates = contract_life_updates(payload, allow_registered=can_register)
                    except ValueError as exc:
                        self.send_json({"error": str(exc)}, 400)
                        return
                    if not updates.get("name"):
                        self.send_json({"error": "Informe o nome da vida."}, 400)
                        return
                    now = now_iso()
                    life_id = str(uuid.uuid4())
                    db.execute(
                        """INSERT INTO contract_lives(id, company_id, name, cpf, cpf_key, birth_date, mother_name, phone, email, role, notes, registered, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            life_id, company_id, updates.get("name", ""), updates.get("cpf", ""),
                            updates.get("cpf_key", ""), updates.get("birth_date", ""),
                            updates.get("mother_name", ""), updates.get("phone", ""),
                            updates.get("email", ""), updates.get("role", ""),
                            updates.get("notes", ""), updates.get("registered", 0), now, now,
                        ),
                    )
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (now, company_id))
                    db.commit()
                    row = db.execute("SELECT * FROM contract_lives WHERE id = ?", (life_id,)).fetchone()
                self.send_json({"life": contract_life_payload(row)}, 201)
                return
            self.send_json({"error": "Rota não encontrada"}, 404)
            return
        if path == "/api/chat/messages":
            normalized = normalize_chat_scope(payload.get("scope"), payload.get("scopeId"))
            if not normalized:
                self.send_json({"error": "Conversa inválida."}, 400)
                return
            scope, scope_id = normalized
            body = str(payload.get("body", "")).strip()
            kind = str(payload.get("kind") or "text").strip().lower()
            media_id = str(payload.get("mediaId") or "").strip()
            mime = str(payload.get("mediaMime") or "").strip().lower()
            media_name = str(payload.get("mediaName") or "").strip()[:160]
            try:
                media_size = int(payload.get("mediaSize") or 0)
            except (TypeError, ValueError):
                media_size = 0
            try:
                media_duration = float(payload.get("mediaDuration") or 0)
            except (TypeError, ValueError):
                media_duration = 0
            if kind not in ("text", "image", "video", "audio", "file"):
                self.send_json({"error": "Tipo de mensagem inválido."}, 400)
                return
            if kind == "text":
                if not body:
                    self.send_json({"error": "Escreva uma mensagem."}, 400)
                    return
                media_id, mime, media_name, media_size, media_duration = "", "", "", 0, 0
            elif not valid_media_file(media_id) or not (MEDIA_DIR / media_id).is_file():
                self.send_json({"error": "Anexo não encontrado. Envie o arquivo novamente."}, 400)
                return
            elif kind == "file":
                if "." + media_id.rpartition(".")[2].lower() not in DOC_EXTENSIONS:
                    self.send_json({"error": "Formato de anexo inválido."}, 400)
                    return
            elif mime not in MEDIA_TYPES or MEDIA_TYPES[mime][0] != kind:
                self.send_json({"error": "Formato de anexo inválido."}, 400)
                return
            if len(body) > 4000:
                self.send_json({"error": "A mensagem pode ter no máximo 4.000 caracteres."}, 400)
                return
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not chat_access(db, user, scope, scope_id):
                    self.send_json({"error": "Você não participa desta conversa."}, 403)
                    return
                message_id = str(uuid.uuid4())
                created_at = now_iso()
                db.execute(
                    """INSERT INTO chat_messages(id, scope, scope_id, user_id, body, kind, media_id, media_mime, media_name, media_size, media_duration, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (message_id, scope, scope_id, user["id"], body, kind, media_id, mime, media_name, media_size, media_duration, created_at),
                )
                chat_mark_read(db, user["id"], scope, scope_id, created_at)
                db.commit()
                row = db.execute(
                    """SELECT m.*, u.display_name, u.photo FROM chat_messages m
                       LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?""",
                    (message_id,),
                ).fetchone()
            self.send_json({"message": chat_message_payload(row)}, 201)
            return
        if path == "/api/tasks/sync":
            try:
                with connection() as db:
                    db.execute("BEGIN IMMEDIATE")
                    user = require_user(db, self)
                    if not user:
                        return
                    result = task_sync.sync(db, payload, user, user_sector_ids(db, user), bool(is_manager(user)))
                    result["state"] = filter_state_for_user(result["state"], user, db)
                    db.commit()
            except ValueError:
                self.send_json({"error": "Não foi possível sincronizar: formato inválido ou alteração grande demais."}, 400)
                return
            self.send_json(result)
            return
        if path == "/api/tasks/assign-sector":
            with connection() as db:
                db.execute("BEGIN IMMEDIATE")
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
        if path == "/api/system/unlock":
            username = str(payload.get("username", "")).strip().lower()
            password = str(payload.get("password", ""))
            with connection() as db:
                user = db.execute("SELECT * FROM users WHERE lower(username) = ?", (username,)).fetchone()
                if not user or not verify_password(password, user["password_hash"]) or user["role"] != "admin":
                    self.send_json({"error": "Informe uma conta de administrador válida."}, 401)
                    return
                if "active" in user.keys() and not user["active"]:
                    self.send_json({"error": "Esta conta está bloqueada. Fale com a administração."}, 403)
                    return
                db.execute("INSERT INTO meta(key, value) VALUES ('system_lock', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
                db.execute("DELETE FROM meta WHERE key IN ('system_lock_message', 'system_lock_since')")
                db.commit()
            self.send_json({"ok": True})
            return
        if path == "/api/system/lock":
            with connection() as db:
                admin = require_admin(db, self)
                if not admin:
                    return
                message = str(payload.get("message") or "").strip()[:300]
                db.execute("INSERT INTO meta(key, value) VALUES ('system_lock', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
                db.execute(
                    "INSERT INTO meta(key, value) VALUES ('system_lock_message', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (message,),
                )
                db.execute(
                    "INSERT INTO meta(key, value) VALUES ('system_lock_since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (now_iso(),),
                )
                db.execute("DELETE FROM sessions")
                db.commit()
            self.send_json({"locked": True, "message": message})
            return
        if path == "/api/login":
            username = str(payload.get("username", "")).strip().lower()
            password = str(payload.get("password", ""))
            with connection() as db:
                user = db.execute("SELECT * FROM users WHERE lower(username) = ?", (username,)).fetchone()
                if not user or not verify_password(password, user["password_hash"]):
                    self.send_json({"error": "Usuário ou senha incorretos."}, 401)
                    return
                if "active" in user.keys() and not user["active"]:
                    self.send_json({"error": "Esta conta está bloqueada. Fale com a administração."}, 403)
                    return
                token = secrets.token_hex(32)
                db.execute("INSERT INTO sessions(token, user_id, created_at) VALUES (?, ?, ?)", (token, user["id"], now_iso()))
                db.execute("UPDATE users SET last_login=? WHERE id=?", (now_iso(), user["id"]))
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
                management = 1 if payload.get("management") else 0
                birthday = normalize_birthday(payload.get("birthday"))
                seller_name = str(payload.get("sellerName") or "").strip()[:80]
                works_saturday = 1 if payload.get("worksSaturday") else 0
                works_sunday = 1 if payload.get("worksSunday") else 0
                db.execute(
                    "INSERT INTO users(id, username, display_name, password_hash, role, sector_id, created_at, management, birthday, seller_name, works_saturday, works_sunday) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (user_id, username, display_name, hash_password(password), role, sector_id, now_iso(), management, birthday, seller_name, works_saturday, works_sunday),
                )
                set_user_screens(db, user_id, payload.get("screens") or [])
                set_user_sectors(db, user_id, requested_sectors if role == "user" else [])
                if birthday:
                    sync_user_birthday(db, user_id, display_name, birthday)
                db.commit()
                user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                self.send_json({"user": row_user(db, user)}, 201)
            return
        if path == "/api/birthdays":
            with connection() as db:
                if not require_admin(db, self):
                    return
                name = str(payload.get("name", "")).strip()
                parts = birthday_parts(payload)
                if not name:
                    self.send_json({"error": "Informe o nome do aniversariante."}, 400)
                    return
                if not parts:
                    self.send_json({"error": "Informe um dia e mês válidos."}, 400)
                    return
                month, day, year = parts
                kind = payload.get("kind") if payload.get("kind") in ("team", "partner") else "team"
                note = str(payload.get("note", "")).strip()
                photo = normalize_photo(payload.get("photo"))
                if photo is False:
                    self.send_json({"error": "Foto inválida. Envie uma imagem de até 900 KB."}, 400)
                    return
                user_id = str(payload.get("userId") or "").strip() or None
                if user_id and not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
                    self.send_json({"error": "Conta vinculada não encontrada."}, 400)
                    return
                bd_id = f"bd-{uuid.uuid4().hex[:12]}"
                db.execute(
                    "INSERT INTO birthdays(id, user_id, name, day, month, year, kind, note, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (bd_id, user_id, name, day, month, year, kind, note, photo, now_iso()),
                )
                if user_id and year:
                    db.execute("UPDATE users SET birthday = ? WHERE id = ?", (birthday_iso(month, day, year), user_id))
                db.commit()
                self.send_json({"birthday": {"id": bd_id}}, 201)
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
        # ── POST /api/announcements — criar comunicado ────────────────────────
        if path == "/api/announcements":
            with connection() as db:
                if not require_admin(db, self):
                    return
                ann = {
                    "id": str(uuid.uuid4()),
                    "title": str(payload.get("title", "")).strip(),
                    "description": str(payload.get("description", "")).strip(),
                    "date": str(payload.get("date", today_iso())),
                    "type": str(payload.get("type", "event")),
                    "active": bool(payload.get("active", True)),
                    "imageData": payload.get("imageData") or None,
                    "color": str(payload.get("color", "#0b8f87")),
                    "createdAt": now_iso(),
                    "updatedAt": now_iso(),
                }
                if not ann["title"]:
                    self.send_json({"error": "Título obrigatório."}, 400)
                    return
                items = self._get_announcements(db)
                items.append(ann)
                self._save_announcements(db, items)
                self.send_json({"announcement": ann}, 201)
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path
        if deny_if_locked(self, path):
            return
        try:
            payload = read_json(self)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "JSON inválido"}, 400)
            return
        if path == "/api/vendas/vinculos":
            with connection() as db:
                user = require_admin(db, self)
                if not user:
                    return
                try:
                    vendas.confirm_link(db, payload, user["id"])
                except (ValueError, TypeError) as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                db.commit()
            self.send_json({"ok": True})
            return
        if path.startswith("/api/cobranca/templates/"):
            template_id = unquote(path[len("/api/cobranca/templates/"):]).strip("/")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM cobranca_templates WHERE id = ?", (template_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Modelo não encontrado."}, 404)
                    return
                name = str(payload.get("name") or row["name"]).strip()[:120]
                channel = str(payload.get("channel") or row["channel"]).strip()
                body = str(payload.get("body") if "body" in payload else row["body"]).strip()
                if channel not in ("email", "whatsapp") or not name or not body:
                    self.send_json({"error": "Informe nome, canal e texto do modelo."}, 400)
                    return
                db.execute(
                    "UPDATE cobranca_templates SET name = ?, channel = ?, tipo = ?, subject = ?, body = ?, active = ? WHERE id = ?",
                    (
                        name, channel, str(payload.get("tipo") if "tipo" in payload else row["tipo"]).strip().upper()[:40],
                        str(payload.get("subject") if "subject" in payload else row["subject"]).strip()[:200],
                        body, 0 if payload.get("active") is False else 1, template_id,
                    ),
                )
                updated = db.execute("SELECT * FROM cobranca_templates WHERE id = ?", (template_id,)).fetchone()
            self.send_json({"ok": True, "template": cobranca_template_payload(updated)})
            return
        if path.startswith("/api/cobranca/"):
            case_id = unquote(path[len("/api/cobranca/"):]).strip("/")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                case = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                if not case:
                    self.send_json({"error": "Cobrança não encontrada."}, 404)
                    return
                status = str(payload.get("status") or case["status"]).strip()
                if status not in COBRANCA_STATUS_LABELS:
                    self.send_json({"error": "Situação inválida."}, 400)
                    return
                emails = cobranca_clean_list(payload["emails"]) if "emails" in payload else cobranca_clean_list(case["emails"])
                phones = cobranca_clean_list(payload["phones"]) if "phones" in payload else cobranca_clean_list(case["phones"])
                next_contact = cobranca_date_iso(payload.get("nextContact")) if "nextContact" in payload else case["next_contact"]
                notes = str(payload.get("notes") if "notes" in payload else case["notes"])[:4000]
                stamp = now_iso()
                db.execute(
                    "UPDATE cobranca_cases SET status = ?, emails = ?, phones = ?, next_contact = ?, notes = ?, "
                    "closed_at = CASE WHEN ? IN ('pago', 'encerrado') THEN COALESCE(closed_at, ?) ELSE NULL END WHERE id = ?",
                    (
                        status, json.dumps(emails, ensure_ascii=False), json.dumps(phones, ensure_ascii=False),
                        next_contact or None, notes, status, stamp, case_id,
                    ),
                )
                updated = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                history = db.execute(
                    "SELECT * FROM cobranca_history WHERE case_id = ? ORDER BY at DESC LIMIT 80", (case_id,)
                ).fetchall()
            self.send_json({
                "ok": True,
                "case": cobranca_case_payload(updated),
                "history": [cobranca_history_payload(row) for row in history],
            })
            return
        if path == "/api/me/photo":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if "photo" not in payload:
                    self.send_json({"error": "Envie a foto ou use null para remover."}, 400)
                    return
                photo = normalize_photo(payload.get("photo"))
                if photo is False:
                    self.send_json({"error": "Foto inválida. Envie uma imagem de até 900 KB."}, 400)
                    return
                db.execute("UPDATE users SET photo = ? WHERE id = ?", (photo, user["id"]))
                db.commit()
                updated = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
                self.send_json({"user": row_user(db, updated)})
            return
        if path == "/api/me/status":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                try:
                    status = normalize_status(payload)
                except ValueError as error:
                    self.send_json({"error": str(error)}, 400)
                    return
                db.execute(
                    "UPDATE users SET status_emoji = ?, status_text = ?, status_until = ? WHERE id = ?",
                    (status["emoji"], status["text"], status["until"], user["id"]),
                )
                db.commit()
                updated = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
                self.send_json({"user": row_user(db, updated)})
            return
        if path == "/api/state":
            with connection() as db:
                db.execute("BEGIN IMMEDIATE")
                user = require_user(db, self)
                if not user:
                    return
                row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
                existing = json.loads(row["data"]) if row else {}
                if "tasks" in payload or "deletedTaskIds" in payload:
                    self.send_json({"error": "Atualize o portal para sincronizar demandas com proteção contra conflitos."}, 409)
                    return
                existing["deletedTaskIds"] = sorted(set(existing.get("deletedTaskIds") or []) | {
                    row[0] for row in db.execute("SELECT task_id FROM task_sync_tombstones")
                })
                merged = merge_state(existing, payload, user, db)
                db.executemany("INSERT OR IGNORE INTO task_sync_tombstones(task_id) VALUES (?)",
                               ((task_id,) for task_id in merged.get("deletedTaskIds") or []))
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
                admin = require_admin(db, self)
                if not admin:
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
                sector_editable = any(key in payload for key in ("sectorIds", "sectorId", "role"))
                if role == "user" and not requested_sectors and sector_editable:
                    self.send_json({"error": "Escolha o setor desta conta."}, 400)
                    return
                sector_id = None if role == "admin" else requested_sectors[0]
                if any(not db.execute("SELECT 1 FROM sectors WHERE id = ?", (item,)).fetchone() for item in requested_sectors):
                    self.send_json({"error": "Setor não encontrado."}, 400)
                    return
                seller_name = str(payload.get("sellerName", user["seller_name"] if "seller_name" in user.keys() else "") or "").strip()[:80]
                management = 1 if payload.get("management", user["management"] if "management" in user.keys() else 0) else 0
                db.execute("UPDATE users SET display_name = ?, role = ?, sector_id = ?, management = ?, seller_name = ? WHERE id = ?", (display_name, role, sector_id, management, seller_name, user_id))
                if "worksSaturday" in payload:
                    db.execute("UPDATE users SET works_saturday = ? WHERE id = ?", (1 if payload.get("worksSaturday") else 0, user_id))
                if "worksSunday" in payload:
                    db.execute("UPDATE users SET works_sunday = ? WHERE id = ?", (1 if payload.get("worksSunday") else 0, user_id))
                birthday = None
                if "birthday" in payload:
                    birthday = normalize_birthday(payload.get("birthday"))
                    db.execute("UPDATE users SET birthday = ? WHERE id = ?", (birthday, user_id))
                set_user_sectors(db, user_id, requested_sectors if role == "user" else [])
                if "birthday" in payload:
                    sync_user_birthday(db, user_id, display_name, birthday)
                if payload.get("password"):
                    if len(str(payload["password"])) < 4:
                        self.send_json({"error": "A senha precisa ter pelo menos 4 caracteres."}, 400)
                        return
                    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(str(payload["password"])), user_id))
                    db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                if "screens" in payload:
                    set_user_screens(db, user_id, payload.get("screens") or [])
                if "active" in payload:
                    active = 1 if payload.get("active") else 0
                    if not active:
                        if user_id == admin["id"]:
                            self.send_json({"error": "Você não pode bloquear a própria conta."}, 400)
                            return
                        if user["role"] == "admin":
                            active_admins = db.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").fetchone()["n"]
                            if active_admins <= 1:
                                self.send_json({"error": "Precisa existir pelo menos um administrador com acesso liberado."}, 400)
                                return
                    db.execute("UPDATE users SET active = ? WHERE id = ?", (active, user_id))
                    if not active:
                        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                db.commit()
                updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                self.send_json({"user": row_user(db, updated)})
            return
        if path.startswith("/api/birthdays/"):
            bd_id = unquote(path.split("/api/birthdays/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                row = db.execute("SELECT * FROM birthdays WHERE id = ?", (bd_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Aniversariante não encontrado."}, 404)
                    return
                name = str(payload.get("name", row["name"])).strip() or row["name"]
                parts = birthday_parts(payload, {"day": row["day"], "month": row["month"], "year": row["year"]})
                if not parts:
                    self.send_json({"error": "Informe um dia e mês válidos."}, 400)
                    return
                month, day, year = parts
                kind = payload.get("kind", row["kind"])
                if kind not in ("team", "partner"):
                    kind = row["kind"]
                note = str(payload.get("note", row["note"])).strip()
                if "photo" in payload:
                    photo = normalize_photo(payload.get("photo"))
                    if photo is False:
                        self.send_json({"error": "Foto inválida. Envie uma imagem de até 900 KB."}, 400)
                        return
                else:
                    photo = row["photo"]
                if "userId" in payload:
                    user_id = str(payload.get("userId") or "").strip() or None
                else:
                    user_id = row["user_id"]
                if user_id and not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
                    self.send_json({"error": "Conta vinculada não encontrada."}, 400)
                    return
                db.execute(
                    "UPDATE birthdays SET user_id = ?, name = ?, day = ?, month = ?, year = ?, kind = ?, note = ?, photo = ? WHERE id = ?",
                    (user_id, name, day, month, year, kind, note, photo, bd_id),
                )
                if user_id:
                    db.execute("UPDATE users SET birthday = ? WHERE id = ?", (birthday_iso(month, day, year), user_id))
                db.commit()
                self.send_json({"updated": True})
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
        # ── PUT /api/announcements/<id> — editar comunicado ──────────────────
        if path.startswith("/api/announcements/"):
            ann_id = unquote(path.split("/api/announcements/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                items = self._get_announcements(db)
                item = next((a for a in items if str(a.get("id")) == ann_id), None)
                if not item:
                    self.send_json({"error": "Comunicado não encontrado."}, 404)
                    return
                for field in ("title", "description", "date", "type", "active", "imageData", "color"):
                    if field in payload:
                        item[field] = payload[field]
                item["updatedAt"] = now_iso()
                self._save_announcements(db, items)
                self.send_json({"announcement": item})
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def do_PATCH(self):
        path = urlparse(self.path).path
        if deny_if_locked(self, path):
            return
        try:
            payload = read_json(self)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "JSON inválido"}, 400)
            return
        if path.startswith("/api/commissions/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[2] == "companies":
                company_id = parts[3]
                with connection() as db:
                    user = require_commissions(db, self)
                    if not user:
                        return
                    existing = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                    if not existing:
                        self.send_json({"error": "Contrato não encontrado."}, 404)
                        return
                    if not company_in_scope(existing, commission_scope(db, user)):
                        self.send_json({"error": "Você só pode editar os seus contratos."}, 403)
                        return
                    try:
                        updates = contract_company_updates(payload)
                    except ValueError as exc:
                        self.send_json({"error": str(exc)}, 400)
                        return
                    if not is_manager(user):
                        updates["seller"] = user_seller_name(user)[:120]
                    if updates:
                        updates["updated_at"] = now_iso()
                        assignments = ", ".join(f"{field} = ?" for field in updates)
                        db.execute(f"UPDATE contract_companies SET {assignments} WHERE id = ?", (*updates.values(), company_id))
                        db.commit()
                    row = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                    company = commission_company_payload(db, row)
                self.send_json({"company": company})
                return
            if len(parts) == 4 and parts[2] == "movements":
                movement_id = parts[3]
                with connection() as db:
                    user = require_commissions(db, self)
                    if not user:
                        return
                    existing = db.execute(
                        """SELECT m.*, c.seller AS company_seller FROM contract_movements m
                           JOIN contract_companies c ON c.id = m.company_id WHERE m.id = ?""",
                        (movement_id,),
                    ).fetchone()
                    if not existing:
                        self.send_json({"error": "Movimentação não encontrada."}, 404)
                        return
                    seller_key = commission_scope(db, user)
                    if seller_key is not None and contract_key(existing["company_seller"]) != seller_key:
                        self.send_json({"error": "Você só pode editar movimentações dos seus contratos."}, 403)
                        return
                    values = contract_movement_values(payload, existing)
                    values["updated_at"] = now_iso()
                    assignments = ", ".join(f"{field} = ?" for field in values)
                    db.execute(f"UPDATE contract_movements SET {assignments} WHERE id = ?", (*values.values(), movement_id))
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (now_iso(), existing["company_id"]))
                    db.commit()
                    row = db.execute("SELECT * FROM contract_movements WHERE id = ?", (movement_id,)).fetchone()
                self.send_json({"movement": contract_movement_payload(row)})
                return
        if not path.startswith("/api/contracts/"):
            self.send_json({"error": "Rota não encontrada"}, 404)
            return
        parts = [unquote(part) for part in path.split("/") if part]
        if len(parts) == 3:
            company_id = parts[2]
            with connection() as db:
                user = require_contracts(db, self)
                if not user:
                    return
                if not db.execute("SELECT 1 FROM contract_companies WHERE id = ?", (company_id,)).fetchone():
                    self.send_json({"error": "Empresa não encontrada."}, 404)
                    return
                try:
                    updates = contract_company_updates(payload, allow_values=can_edit_contract_values(db, user))
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                if updates:
                    updates["updated_at"] = now_iso()
                    assignments = ", ".join(f"{field} = ?" for field in updates)
                    db.execute(f"UPDATE contract_companies SET {assignments} WHERE id = ?", (*updates.values(), company_id))
                    db.commit()
                company, lives = contract_company_view(db, company_id, is_manager(user))
            self.send_json({"company": company, "lives": lives})
            return
        if len(parts) == 4 and parts[3] == "registration":
            company_id = parts[2]
            with connection() as db:
                user = require_contracts(db, self)
                if not user:
                    return
                existing = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                if not existing:
                    self.send_json({"error": "Empresa não encontrada."}, 404)
                    return
                registered = 1 if payload.get("registered") else 0
                now = now_iso()
                changed = int(existing["registered"] or 0) != registered
                event = None
                if changed:
                    actor = str(user["display_name"] or user["username"] or "").strip()
                    db.execute(
                        """UPDATE contract_companies
                           SET registered = ?, registered_at = ?, registered_by = ?, updated_at = ?
                           WHERE id = ?""",
                        (registered, now if registered else "", actor if registered else "", now, company_id),
                    )
                    contract_registration_record(db, existing, registered, actor, now)
                    db.commit()
                    event = db.execute(
                        "SELECT id, company_name, registered, created_at FROM contract_registration_events ORDER BY id DESC LIMIT 1"
                    ).fetchone()
                company, lives = contract_company_view(db, company_id, is_manager(user))
            self.send_json({
                "company": company,
                "lives": lives,
                "changed": changed,
                "event": {
                    "id": event["id"],
                    "companyId": company_id,
                    "companyName": event["company_name"],
                    "registered": bool(event["registered"]),
                    "createdAt": event["created_at"],
                } if event else None,
            })
            return
        if len(parts) == 5 and parts[3] == "lives":
            company_id, life_id = parts[2], parts[4]
            with connection() as db:
                user, can_register = require_lives_access(db, self, company_id)
                if not user:
                    return
                existing = db.execute(
                    "SELECT * FROM contract_lives WHERE id = ? AND company_id = ?",
                    (life_id, company_id),
                ).fetchone()
                if not existing:
                    self.send_json({"error": "Vida não encontrada."}, 404)
                    return
                try:
                    updates = contract_life_updates(payload, allow_registered=can_register)
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
                if updates:
                    updates["updated_at"] = now_iso()
                    assignments = ", ".join(f"{field} = ?" for field in updates)
                    db.execute(f"UPDATE contract_lives SET {assignments} WHERE id = ?", (*updates.values(), life_id))
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (updates["updated_at"], company_id))
                    db.commit()
                row = db.execute("SELECT * FROM contract_lives WHERE id = ?", (life_id,)).fetchone()
            self.send_json({"life": contract_life_payload(row)})
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if deny_if_locked(self, path):
            return
        if path.startswith("/api/rateios-faturamento/regras/"):
            rule_id = unquote(path[len("/api/rateios-faturamento/regras/"):]).strip("/")
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente a administração pode excluir regras."}, 403)
                    return
                db.execute("DELETE FROM rateio_rules WHERE id = ?", (rule_id,))
                db.commit()
            self.send_json({"ok": True})
            return
        if path.startswith("/api/apuracao/mapa/"):
            mapa_id = unquote(path[len("/api/apuracao/mapa/"):]).strip("/")
            with connection() as db:
                user = require_apuracao(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente o administrador pode excluir o mapeamento."}, 403)
                    return
                row = db.execute("SELECT * FROM apuracao_map WHERE id = ?", (mapa_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Mapeamento não encontrado."}, 404)
                    return
                db.execute("DELETE FROM apuracao_map WHERE id = ?", (mapa_id,))
                db.commit()
            self.send_json({"ok": True})
            return
        if path.startswith("/api/cobranca/templates/"):
            template_id = unquote(path[len("/api/cobranca/templates/"):]).strip("/")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM cobranca_templates WHERE id = ?", (template_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Modelo não encontrado."}, 404)
                    return
                db.execute("DELETE FROM cobranca_templates WHERE id = ?", (template_id,))
            self.send_json({"ok": True})
            return
        if path.startswith("/api/cobranca/"):
            case_id = unquote(path[len("/api/cobranca/"):]).strip("/")
            with connection() as db:
                user = require_cobranca(db, self)
                if not user:
                    return
                if user["role"] != "admin":
                    self.send_json({"error": "Somente o administrador pode excluir uma cobrança."}, 403)
                    return
                case = db.execute("SELECT * FROM cobranca_cases WHERE id = ?", (case_id,)).fetchone()
                if not case:
                    self.send_json({"error": "Cobrança não encontrada."}, 404)
                    return
                db.execute("DELETE FROM cobranca_history WHERE case_id = ?", (case_id,))
                db.execute("DELETE FROM cobranca_cases WHERE id = ?", (case_id,))
            self.send_json({"ok": True})
            return
        if path.startswith("/api/finance/imports/"):
            import_id = unquote(path[len("/api/finance/imports/"):]).strip("/")
            with connection() as db:
                user = require_finance(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM finance_imports WHERE id = ?", (import_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Importação não encontrada."}, 404)
                    return
                if not is_manager(user) and row["user_id"] != user["id"]:
                    self.send_json({"error": "Você só pode excluir as importações que fez."}, 403)
                    return
                db.execute("DELETE FROM finance_rateios WHERE import_id = ?", (import_id,))
                db.execute("DELETE FROM finance_imports WHERE id = ?", (import_id,))
            self.send_json({"deleted": True, "id": import_id})
            return
        if path.startswith("/api/feed/comments/"):
            comment_id = unquote(path[len("/api/feed/comments/"):]).strip("/")
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM feed_comments WHERE id = ?", (comment_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Comentário não encontrado."}, 404)
                    return
                if not is_manager(user) and row["author_id"] != user["id"]:
                    self.send_json({"error": "Você só pode excluir os seus comentários."}, 403)
                    return
                children = db.execute(
                    "SELECT id, author_id FROM feed_comments WHERE parent_id = ?",
                    (comment_id,),
                ).fetchall()
                if not is_manager(user) and any(child["author_id"] != user["id"] for child in children):
                    self.send_json({"error": "Este comentário tem respostas de outras pessoas. Peça à administração para remover."}, 403)
                    return
                ids = [comment_id] + [child["id"] for child in children]
                db.execute("DELETE FROM feed_comments WHERE id = ?", (comment_id,))
                db.execute("DELETE FROM feed_comments WHERE parent_id = ?", (comment_id,))
                db.commit()
            self.send_json({"deleted": True, "ids": ids})
            return
        if path.startswith("/api/feed/"):
            post_id = unquote(path[len("/api/feed/"):]).strip("/")
            query = parse_qs(urlparse(self.path).query)
            reason = str((query.get("reason") or [""])[0]).strip()
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                row = db.execute("SELECT * FROM feed_posts WHERE id = ?", (post_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Publicação não encontrada."}, 404)
                    return
                if not is_manager(user) and (row["author_id"] or "") != user["id"]:
                    self.send_json({"error": "Você só pode excluir as suas publicações."}, 403)
                    return
                author_id = row["author_id"] or ""
                moderated = bool(is_manager(user) and author_id and author_id != user["id"])
                if moderated:
                    if len(reason) < 3:
                        self.send_json({"error": "Informe o motivo da remoção para avisar o autor."}, 400)
                        return
                    if len(reason) > 500:
                        reason = reason[:500]
                    db.execute(
                        "INSERT INTO feed_notices(id, user_id, post_id, post_title, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            str(uuid.uuid4()), author_id, post_id,
                            row["title"] or (row["body"] or "")[:120], reason, now_iso(),
                        ),
                    )
                media_rows = db.execute("SELECT * FROM feed_media WHERE post_id = ?", (post_id,)).fetchall()
                db.execute("DELETE FROM feed_media WHERE post_id = ?", (post_id,))
                db.execute("DELETE FROM feed_comments WHERE post_id = ?", (post_id,))
                db.execute("DELETE FROM feed_likes WHERE post_id = ?", (post_id,))
                db.execute("DELETE FROM feed_reads WHERE post_id = ?", (post_id,))
                db.execute("DELETE FROM feed_posts WHERE id = ?", (post_id,))
                db.commit()
                delete_feed_media_files(media_rows)
            self.send_json({"deleted": True, "notified": moderated})
            return
        if path.startswith("/api/system-updates/"):
            update_id = unquote(path[len("/api/system-updates/"):]).strip("/")
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                if not is_manager(user):
                    self.send_json({"error": "Apenas a administração pode remover novidades."}, 403)
                    return
                db.execute("DELETE FROM system_updates WHERE id = ?", (update_id,))
                db.commit()
            self.send_json({"deleted": True})
            return
        if path.startswith("/api/commissions/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[2] == "companies":
                company_id = parts[3]
                with connection() as db:
                    user = require_commissions(db, self)
                    if not user:
                        return
                    existing = db.execute("SELECT * FROM contract_companies WHERE id = ?", (company_id,)).fetchone()
                    if not existing:
                        self.send_json({"error": "Contrato não encontrado."}, 404)
                        return
                    if not company_in_scope(existing, commission_scope(db, user)):
                        self.send_json({"error": "Você só pode excluir os seus contratos."}, 403)
                        return
                    db.execute("DELETE FROM contract_movements WHERE company_id = ?", (company_id,))
                    db.execute("DELETE FROM contract_lives WHERE company_id = ?", (company_id,))
                    db.execute("DELETE FROM contract_companies WHERE id = ?", (company_id,))
                    db.commit()
                self.send_json({"deleted": True})
                return
            if len(parts) == 4 and parts[2] == "movements":
                movement_id = parts[3]
                with connection() as db:
                    user = require_commissions(db, self)
                    if not user:
                        return
                    existing = db.execute(
                        """SELECT m.*, c.seller AS company_seller FROM contract_movements m
                           JOIN contract_companies c ON c.id = m.company_id WHERE m.id = ?""",
                        (movement_id,),
                    ).fetchone()
                    if not existing:
                        self.send_json({"error": "Movimentação não encontrada."}, 404)
                        return
                    seller_key = commission_scope(db, user)
                    if seller_key is not None and contract_key(existing["company_seller"]) != seller_key:
                        self.send_json({"error": "Você só pode excluir movimentações dos seus contratos."}, 403)
                        return
                    db.execute("DELETE FROM contract_movements WHERE id = ?", (movement_id,))
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (now_iso(), existing["company_id"]))
                    db.commit()
                self.send_json({"deleted": True})
                return
            self.send_json({"error": "Rota não encontrada"}, 404)
            return
        if path.startswith("/api/contracts/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 5 and parts[3] == "lives":
                company_id, life_id = parts[2], parts[4]
                with connection() as db:
                    user, _ = require_lives_access(db, self, company_id)
                    if not user:
                        return
                    row = db.execute(
                        "SELECT 1 FROM contract_lives WHERE id = ? AND company_id = ?",
                        (life_id, company_id),
                    ).fetchone()
                    if not row:
                        self.send_json({"error": "Vida não encontrada."}, 404)
                        return
                    db.execute("DELETE FROM contract_lives WHERE id = ?", (life_id,))
                    db.execute("UPDATE contract_companies SET updated_at = ? WHERE id = ?", (now_iso(), company_id))
                    db.commit()
                self.send_json({"deleted": True})
                return
            if len(parts) == 3:
                company_id = parts[2]
                with connection() as db:
                    if not require_contracts(db, self):
                        return
                    if not db.execute("SELECT 1 FROM contract_companies WHERE id = ?", (company_id,)).fetchone():
                        self.send_json({"error": "Empresa não encontrada."}, 404)
                        return
                    db.execute("DELETE FROM contract_lives WHERE company_id = ?", (company_id,))
                    db.execute("DELETE FROM contract_movements WHERE company_id = ?", (company_id,))
                    db.execute("DELETE FROM contract_companies WHERE id = ?", (company_id,))
                    db.commit()
                self.send_json({"deleted": True})
                return
            self.send_json({"error": "Rota não encontrada"}, 404)
            return
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
                db.execute("UPDATE birthdays SET user_id = NULL WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM user_screens WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM users WHERE id = ?", (user_id,))
                db.commit()
            self.send_json({"deleted": True})
            return
        if path.startswith("/api/birthdays/"):
            bd_id = unquote(path.split("/api/birthdays/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                row = db.execute("SELECT * FROM birthdays WHERE id = ?", (bd_id,)).fetchone()
                if not row:
                    self.send_json({"error": "Aniversariante não encontrado."}, 404)
                    return
                if row["user_id"]:
                    db.execute("UPDATE users SET birthday = NULL WHERE id = ?", (row["user_id"],))
                db.execute("DELETE FROM birthdays WHERE id = ?", (bd_id,))
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
        # ── DELETE /api/announcements/<id> — remover comunicado ──────────────
        if path.startswith("/api/announcements/"):
            ann_id = unquote(path.split("/api/announcements/", 1)[1])
            with connection() as db:
                if not require_admin(db, self):
                    return
                items = self._get_announcements(db)
                new_items = [a for a in items if str(a.get("id")) != ann_id]
                if len(new_items) == len(items):
                    self.send_json({"error": "Comunicado não encontrado."}, 404)
                    return
                self._save_announcements(db, new_items)
                self.send_json({"deleted": True})
            return
        self.send_json({"error": "Rota não encontrada"}, 404)

    def send_media_file(self, path):
        total = path.stat().st_size
        start, end = 0, max(total - 1, 0)
        partial = False
        header = self.headers.get("Range") or ""
        if total and header.startswith("bytes="):
            spec = header[6:].split(",")[0].strip()
            first, _, last = spec.partition("-")
            try:
                if first:
                    start = int(first)
                    end = int(last) if last else total - 1
                elif last:
                    start = max(0, total - int(last))
            except ValueError:
                start, end = 0, total - 1
            start = max(0, min(start, total - 1))
            end = max(start, min(end, total - 1))
            partial = True
        chunk_size = (end - start + 1) if total else 0
        inline = path.suffix.lower() in INLINE_MEDIA_SUFFIXES
        content_type = (mimetypes.guess_type(path.name)[0] or "application/octet-stream") if inline else "application/octet-stream"
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(chunk_size))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        if inline:
            self.send_header("Cache-Control", "private, max-age=3600")
        else:
            self.send_header("Content-Disposition", "attachment")
            self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not chunk_size:
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = chunk_size
            while remaining > 0:
                block = handle.read(min(1_048_576, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def serve_file(self, requested):
        parsed = urlparse(requested)
        relative = unquote(parsed.path.lstrip("/")) or "index.html"
        path = (ROOT / relative).resolve()
        if ROOT not in path.parents and path != ROOT:
            self.send_error(403)
            return
        if not path.is_file():
            self.send_error(404)
            return
        if path.parent == MEDIA_DIR.resolve():
            token = (parse_qs(parsed.query).get("t") or [""])[0]
            with connection() as db:
                allowed = db.execute("SELECT 1 FROM sessions WHERE token = ?", (token,)).fetchone()
            if not allowed:
                self.send_error(401)
                return
            self.send_media_file(path)
            return
        if is_private_static(path.relative_to(ROOT)):
            self.send_error(404)
            return
        content = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        public_shell = relative == "index.html" or (path.parent == ROOT and path.suffix in (".js", ".css")) or relative in (
            "feed-react/feed-react.js", "assets/rede-saude-icone.png", "assets/rede-saude.png"
        )
        self.send_header("Cache-Control", "public, max-age=0, must-revalidate" if public_shell else "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
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


def generate_daily_now():
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
        state = json.loads(row["data"]) if row else {}
        if not ensure_recurring_occurrences(state, db):
            return
        db.execute(
            "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
            (json.dumps(state, ensure_ascii=False),),
        )
        db.commit()


def recurring_worker():
    while True:
        try:
            generate_daily_now()
        except Exception as error:
            print(f"Falha ao gerar demandas diárias: {error}", flush=True)
        time.sleep(900)


retornos.configure(connection, s4e_saved_credentials, lambda: apuracao_job_status().get("running") or s4e.job_status().get("running") or vendas.job_status().get("running") or vidas.job_status().get("running") or s4e_notas.job_status().get("running") or relatorio_semanal.job_status().get("running"))
vendas.configure(connection, s4e_saved_credentials, lambda: apuracao_job_status().get("running") or s4e.job_status().get("running") or retornos._state.get("running") or vidas.job_status().get("running") or s4e_notas.job_status().get("running") or relatorio_semanal.job_status().get("running"))
vidas.configure(connection, s4e_saved_credentials, lambda: apuracao_job_status().get("running") or s4e.job_status().get("running") or retornos._state.get("running") or vendas.job_status().get("running") or s4e_notas.job_status().get("running") or relatorio_semanal.job_status().get("running"))
s4e_notas.configure(connection, s4e_saved_credentials, lambda: apuracao_job_status().get("running") or s4e.job_status().get("running") or retornos._state.get("running") or vendas.job_status().get("running") or vidas.job_status().get("running") or relatorio_semanal.job_status().get("running"))
relatorio_semanal.configure(connection, s4e_saved_credentials, lambda: apuracao_job_status().get("running") or s4e.job_status().get("running") or retornos._state.get("running") or vendas.job_status().get("running") or vidas.job_status().get("running") or s4e_notas.job_status().get("running"))


if __name__ == "__main__":
    with connection() as db:
        cobranca_sends_backfill(db)
        apuracao_seed_map(db)
        db.commit()
    threading.Thread(target=recurring_worker, name="gerador-demandas-diarias", daemon=True).start()
    threading.Thread(target=apuracao_scheduler_worker, name="agendador-apuracao", daemon=True).start()
    threading.Thread(target=cobranca_scheduler_worker, name="agendador-cobranca", daemon=True).start()
    retornos.activate()
    threading.Thread(target=retornos.scheduler, name="monitor-retornos", daemon=True).start()
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
