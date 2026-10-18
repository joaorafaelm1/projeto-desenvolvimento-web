PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS denuncias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_denuncia TEXT NOT NULL CHECK (tipo_denuncia IN ('anon', 'identified')),
  tipo_violencia TEXT NOT NULL,
  descricao TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Recebida',
  triagem_nivel TEXT,
  triagem_confianca REAL,
  triagem_modelo TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  expira_em INTEGER NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  acao TEXT NOT NULL,
  detalhes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
);
