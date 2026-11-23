"""Importa os arquivos da pasta Treinamentos para a aba 'Treinamentos do Setor'.

Os arquivos são registrados como recursos da biblioteca apontando para a URL
estática servida pelo portal (ex.: /Treinamentos/arquivo.pdf), evitando estourar
o localStorage do navegador com base64.
"""

import json
import mimetypes
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import sqlite3

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "portal.db"
TRAINING_DIR = ROOT / "Treinamentos"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def resource_kind(name):
    if name.lower().endswith(".pdf"):
        return "PDF"
    return "IMG"


def main():
    files = sorted(
        p for p in TRAINING_DIR.iterdir()
        if p.is_file() and not p.name.startswith(".")
    )
    if not files:
        print("Nenhum arquivo encontrado em Treinamentos/")
        return

    db = sqlite3.connect(DB_PATH)
    db.execute(
        "CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    row = db.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    state = json.loads(row[0]) if row else {}
    learning = state.get("learningData") or {}
    resources = learning.get("resources") or []

    existing_names = {item.get("name") for item in resources}
    added = []
    for path in files:
        if path.name in existing_names:
            print(f"  ja existe: {path.name}")
            continue
        url = "/Treinamentos/" + urllib.parse.quote(path.name)
        size_kb = max(1, round(path.stat().st_size / 1024))
        resources.append({
            "name": path.name,
            "type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "size": f"{size_kb} KB",
            "data": url,
            "url": url,
            "createdAt": now_iso(),
        })
        added.append(path.name)

    learning["resources"] = resources
    state["learningData"] = learning
    db.execute(
        "INSERT INTO portal_state(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
        (json.dumps(state, ensure_ascii=False),),
    )
    db.commit()
    db.close()

    print(f"Adicionados {len(added)} arquivos:")
    for name in added:
        print(f"  + {name}")


if __name__ == "__main__":
    main()
