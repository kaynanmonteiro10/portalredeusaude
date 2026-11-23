#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('portal.db')
cursor = db.cursor()

# Criar tabela adesoes
cursor.execute("""
CREATE TABLE IF NOT EXISTS adesoes (
    id TEXT PRIMARY KEY,
    lote TEXT NOT NULL,
    empresa TEXT NOT NULL,
    data_entrada TEXT NOT NULL,
    data_adesao TEXT NOT NULL,
    vidas INTEGER NOT NULL,
    valor REAL NOT NULL,
    tipo TEXT NOT NULL CHECK(tipo IN ('WEB', 'CRM')),
    situacao TEXT,
    conferencia_status TEXT DEFAULT 'pendente' CHECK(conferencia_status IN ('pendente', 'validado', 'alerta', 'erro')),
    conferencia_resultado TEXT,
    notas_conferencia TEXT,
    conferido_em TEXT,
    conferido_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
)
""")

# Criar índices para performance
cursor.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_lote ON adesoes(lote)")
cursor.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_empresa ON adesoes(empresa)")
cursor.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_tipo ON adesoes(tipo)")
cursor.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_status ON adesoes(conferencia_status)")
cursor.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_data_entrada ON adesoes(data_entrada)")

db.commit()
db.close()

print("✅ Tabela 'adesoes' criada com sucesso!")
