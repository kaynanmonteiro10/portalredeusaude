-- Intranet Rede Saúde — SQLite
-- O servidor Python (portal_server.py) cria estas tabelas sozinho.

CREATE TABLE IF NOT EXISTS portal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'sector')),
  sector TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_screens (
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  PRIMARY KEY (user_id, screen_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (screen_id) REFERENCES screens(id)
);

CREATE TABLE IF NOT EXISTS adesoes (
  id TEXT PRIMARY KEY,
  lote TEXT NOT NULL,
  empresa TEXT NOT NULL,
  data_entrada TEXT NOT NULL,
  data_adesao TEXT,
  vidas INTEGER,
  valor REAL,
  tipo TEXT CHECK (tipo IN ('WEB', 'CRM')),
  situacao TEXT DEFAULT 'ativo',
  conferencia_status TEXT DEFAULT 'pendente' CHECK (conferencia_status IN ('pendente', 'validado', 'alerta', 'erro')),
  conferencia_resultado TEXT,
  conferido_em TEXT,
  conferido_por TEXT,
  notas_conferencia TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_adesoes_data_entrada ON adesoes(data_entrada);
CREATE INDEX IF NOT EXISTS idx_adesoes_tipo ON adesoes(tipo);
CREATE INDEX IF NOT EXISTS idx_adesoes_conferencia_status ON adesoes(conferencia_status);
