CREATE TABLE IF NOT EXISTS denuncias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_denuncia TEXT NOT NULL,
    tipo_violencia TEXT NOT NULL,
    descricao TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Recebida',
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
