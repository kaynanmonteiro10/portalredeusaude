"""Restaura Contratos e Comissões ao estado anterior à importação de 18/11 08:59.

A rotina de conferência de adesões gravou o cadastro inteiro do S4E em
contract_companies/contract_lives: 1.134 empresas e 52.769 vidas novas, além de
sobrescrever initial_lives/source_file/updated_at de 16 empresas que já existiam.

Desfaz apenas o que foi criado naquele instante e devolve os campos das 16
empresas a partir do backup de 12/11 (portal.db.backup-retornos-vazio-20261112-081058).
Nada anterior a 18/11 08:59 é apagado. Idempotente.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "portal.db"
BACKUP = ROOT / "backups" / "portal.db.backup-retornos-vazio-20261112-081058"
RUN = "2026-11-18T08:59:43-03:00"

# Empresas criadas depois do backup: o valor anterior de initial_lives não está
# no arquivo. Mantemos o atual (que confere com o S4E) e devolvemos o restante.
AFTER_BACKUP = {"Turismo Tres Amigos LTDA", "Rio Mps Transportes Especiais LTDA"}

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
manifest_path = ROOT / "backups" / f"rollback-contratos-{stamp}.json"

db = sqlite3.connect(DB, timeout=20)
db.row_factory = sqlite3.Row
db.execute("PRAGMA busy_timeout = 20000")
backup = sqlite3.connect(BACKUP)
backup.row_factory = sqlite3.Row

created = db.execute(
    "SELECT id, name FROM contract_companies WHERE created_at = ? AND source_file LIKE 'S4E%'", (RUN,)
).fetchall()
created_ids = [row["id"] for row in created]
lives_created = db.execute("SELECT COUNT(*) FROM contract_lives WHERE created_at = ?", (RUN,)).fetchone()[0]
affected = db.execute(
    "SELECT * FROM contract_companies WHERE updated_at = ? AND created_at <> ?", (RUN, RUN)
).fetchall()

if not created_ids and not lives_created:
    print("Nada a restaurar: o lote já foi desfeito.")
    raise SystemExit(0)
if len(created_ids) != 1134 or lives_created != 52769 or len(affected) != 16:
    raise SystemExit(
        f"Abortado: esperava 1134 empresas, 52769 vidas e 16 atualizadas; "
        f"encontrei {len(created_ids)}, {lives_created} e {len(affected)}."
    )

restore = []
for row in affected:
    old = backup.execute("SELECT * FROM contract_companies WHERE id = ?", (row["id"],)).fetchone()
    if old is None:
        if row["name"] not in AFTER_BACKUP:
            raise SystemExit(f"Abortado: {row['name']!r} não está no backup e não é das criadas depois dele.")
        restore.append(( "manual", row["created_at"], row["id"]))
    else:
        restore.append((old["source_file"], old["updated_at"], old["initial_lives"], row["id"]))

manifest = {
    "run": RUN,
    "backup": str(BACKUP.name),
    "companiesCreated": len(created_ids),
    "livesCreated": lives_created,
    "companiesUpdated": len(affected),
    "companyIds": created_ids,
    "updated": [
        {"id": row["id"], "name": row["name"], "to": list(values)}
        for row, values in zip(affected, restore)
    ],
}

try:
    db.execute("BEGIN IMMEDIATE")
    db.executemany("DELETE FROM contract_lives WHERE created_at = ?", [(RUN,)])
    db.executemany("DELETE FROM contract_companies WHERE id = ?", [(i,) for i in created_ids])
    for values in restore:
        if len(values) == 3:
            db.execute(
                "UPDATE contract_companies SET source_file = ?, updated_at = ? WHERE id = ?", values
            )
        else:
            db.execute(
                "UPDATE contract_companies SET source_file = ?, updated_at = ?, initial_lives = ? WHERE id = ?",
                values,
            )
    db.commit()
except Exception:
    db.rollback()
    raise

manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

companies = db.execute("SELECT COUNT(*) FROM contract_companies").fetchone()[0]
lives = db.execute("SELECT COUNT(*) FROM contract_lives").fetchone()[0]
print(f"Empresas: {companies} · vidas: {lives}")
print(f"Backup: {BACKUP.name}")
print(f"Manifesto: {manifest_path.name}")
