'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { classifyTriage } = require('./triage-ai');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'acolhe.db');
const SESSION_MS = 8 * 60 * 60 * 1000;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@acolhe.local').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'Acolhe@2026');

const VIOLENCE_TYPES = new Set(['fisica', 'psicologica', 'patrimonial', 'sexual', 'moral']);
const STATUSES = ['Recebida', 'Em análise', 'Concluída'];
const STATUS_TRANSITIONS = {
  'Recebida': ['Em análise'],
  'Em análise': ['Concluída'],
  'Concluída': []
};

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

function ensureColumn(table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS denuncias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_denuncia TEXT NOT NULL CHECK (tipo_denuncia IN ('anon', 'identified')),
      tipo_violencia TEXT NOT NULL,
      descricao TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Recebida',
      criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
  `);

  ensureColumn('denuncias', 'triagem_nivel', 'TEXT');
  ensureColumn('denuncias', 'triagem_confianca', 'REAL');
  ensureColumn('denuncias', 'triagem_modelo', 'TEXT');
  ensureColumn('denuncias', 'atualizado_em', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_denuncias_status ON denuncias(status);
    CREATE INDEX IF NOT EXISTS idx_denuncias_tipo ON denuncias(tipo_violencia);
    CREATE INDEX IF NOT EXISTS idx_denuncias_triagem ON denuncias(triagem_nivel);
    CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria(criado_em);
    DELETE FROM sessoes WHERE expira_em <= ${Date.now()};
  `);

  const emptyUpdated = db.prepare("UPDATE denuncias SET atualizado_em = criado_em WHERE atualizado_em IS NULL OR atualizado_em = ''");
  emptyUpdated.run();

  seedAdmin();
  classifyLegacyRows();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hex] = String(stored).split(':');
    const expected = Buffer.from(hex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(ADMIN_EMAIL);
  const senhaHash = hashPassword(ADMIN_PASSWORD);
  if (existing) {
    db.prepare('UPDATE admins SET senha_hash = ? WHERE id = ?').run(senhaHash, existing.id);
  } else {
    db.prepare('INSERT INTO admins (email, senha_hash) VALUES (?, ?)').run(ADMIN_EMAIL, senhaHash);
  }
}

function classifyLegacyRows() {
  const rows = db.prepare(`
    SELECT id, descricao, tipo_violencia
    FROM denuncias
    WHERE triagem_nivel IS NULL OR triagem_nivel = ''
  `).all();
  const update = db.prepare(`
    UPDATE denuncias
    SET triagem_nivel = ?, triagem_confianca = ?, triagem_modelo = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const t = classifyTriage(row);
    update.run(t.nivel, t.confianca, t.modelo, row.id);
  }
}

initDatabase();

const insertDenuncia = db.prepare(`
  INSERT INTO denuncias (
    tipo_denuncia, tipo_violencia, descricao, status,
    triagem_nivel, triagem_confianca, triagem_modelo,
    criado_em, atualizado_em
  ) VALUES (?, ?, ?, 'Recebida', ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
`);

const findDenuncia = db.prepare(`
  SELECT id, tipo_denuncia, tipo_violencia, descricao, status,
         triagem_nivel, triagem_confianca, triagem_modelo, criado_em, atualizado_em
  FROM denuncias WHERE id = ?
`);

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function cleanText(value, max = 1000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const cookies = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

function getAuthenticatedAdmin(req) {
  const token = parseCookies(req).acolhe_session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.id, a.email, s.expira_em
    FROM sessoes s JOIN admins a ON a.id = s.admin_id
    WHERE s.token = ? AND s.expira_em > ?
  `).get(token, Date.now());
  return row || null;
}

function requireAdmin(req, res) {
  const admin = getAuthenticatedAdmin(req);
  if (!admin) {
    sendJson(res, 401, { erro: 'Autenticação administrativa necessária.' });
    return null;
  }
  return admin;
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_MS;
  db.prepare('INSERT INTO sessoes (token, admin_id, expira_em) VALUES (?, ?, ?)').run(token, adminId, expires);
  return { token, expires };
}

function sessionCookie(req, token, maxAgeSeconds) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = forwarded === 'https' || process.env.NODE_ENV === 'production';
  return `acolhe_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function audit(adminId, action, details = '') {
  db.prepare('INSERT INTO auditoria (admin_id, acao, detalhes) VALUES (?, ?, ?)')
    .run(adminId || null, action, cleanText(details, 1000));
}

function listAdminDenuncias(url) {
  const where = [];
  const params = [];
  const search = cleanText(url.searchParams.get('search'), 100);
  const status = cleanText(url.searchParams.get('status'), 30);
  const risco = cleanText(url.searchParams.get('risco'), 30);

  if (search) {
    where.push('(CAST(id AS TEXT) LIKE ? OR descricao LIKE ? OR tipo_violencia LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    params.push(status);
  }
  if (risco && ['Padrao', 'Atencao', 'Alta', 'Urgente'].includes(risco)) {
    where.push('triagem_nivel = ?');
    params.push(risco);
  }

  const sql = `
    SELECT id, tipo_denuncia, tipo_violencia, descricao, status,
           triagem_nivel, triagem_confianca, triagem_modelo, criado_em, atualizado_em
    FROM denuncias
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC
    LIMIT 500
  `;
  return db.prepare(sql).all(...params);
}

function analytics() {
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM denuncias').get().n);
  const byStatus = db.prepare('SELECT status AS nome, COUNT(*) AS valor FROM denuncias GROUP BY status ORDER BY valor DESC').all();
  const byType = db.prepare('SELECT tipo_violencia AS nome, COUNT(*) AS valor FROM denuncias GROUP BY tipo_violencia ORDER BY valor DESC').all();
  const byRisk = db.prepare("SELECT COALESCE(triagem_nivel, 'Sem triagem') AS nome, COUNT(*) AS valor FROM denuncias GROUP BY triagem_nivel ORDER BY valor DESC").all();
  const last7 = db.prepare(`
    SELECT substr(criado_em,1,10) AS dia, COUNT(*) AS valor
    FROM denuncias
    WHERE datetime(criado_em) >= datetime('now','-6 days','start of day')
    GROUP BY substr(criado_em,1,10)
    ORDER BY dia
  `).all();
  const statusMap = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const row of byStatus) statusMap[row.nome] = Number(row.valor);
  return { total, status: statusMap, porStatus: byStatus, porTipo: byType, porRisco: byRisk, ultimos7Dias: last7 };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[";,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const headers = ['id','tipo_denuncia','tipo_violencia','descricao','status','triagem_nivel','triagem_confianca','criado_em','atualizado_em'];
  const lines = [headers.join(';')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(';'));
  return '\ufeff' + lines.join('\n');
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

const BLOCKED_STATIC = new Set([
  'server.js','triage-ai.js','test-smoke.js','schema.sql','package.json','.env','.env.example','acolhe.db','acolhe.db-wal','acolhe.db-shm'
]);

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requested).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  const baseName = path.basename(normalized);

  if (BLOCKED_STATIC.has(baseName) || baseName.startsWith('.')) {
    return sendText(res, 403, 'Acesso negado.');
  }

  const filePath = path.resolve(ROOT, normalized);
  if (!filePath.startsWith(path.resolve(ROOT) + path.sep) && filePath !== path.resolve(ROOT, 'index.html')) {
    return sendText(res, 403, 'Acesso negado.');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Arquivo não encontrado.');
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const arr = (loginAttempts.get(ip) || []).filter(t => now - t < windowMs);
  loginAttempts.set(ip, arr);
  return arr.length < 10;
}
function registerFailedLogin(ip) {
  const arr = loginAttempts.get(ip) || [];
  arr.push(Date.now());
  loginAttempts.set(ip, arr);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        banco: 'SQLite',
        autenticacao: true,
        dashboardAnalitico: true,
        ia: 'Naive Bayes local + camada de segurança'
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!loginAllowed(ip)) return sendJson(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
      const body = await readJsonBody(req);
      const email = cleanText(body.email, 200).toLowerCase();
      const password = String(body.senha || '');
      const admin = db.prepare('SELECT id, email, senha_hash FROM admins WHERE email = ?').get(email);
      if (!admin || !verifyPassword(password, admin.senha_hash)) {
        registerFailedLogin(ip);
        return sendJson(res, 401, { erro: 'E-mail ou senha inválidos.' });
      }
      loginAttempts.delete(ip);
      db.prepare('DELETE FROM sessoes WHERE admin_id = ? OR expira_em <= ?').run(admin.id, Date.now());
      const session = createSession(admin.id);
      audit(admin.id, 'LOGIN', 'Acesso administrativo efetuado.');
      return sendJson(res, 200, { ok: true, email: admin.email }, {
        'Set-Cookie': sessionCookie(req, session.token, Math.floor(SESSION_MS / 1000))
      });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req).acolhe_session;
      const admin = getAuthenticatedAdmin(req);
      if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
      if (admin) audit(admin.id, 'LOGOUT', 'Sessão administrativa encerrada.');
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(req, '', 0)
      });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const admin = getAuthenticatedAdmin(req);
      return admin ? sendJson(res, 200, { autenticado: true, email: admin.email }) : sendJson(res, 401, { autenticado: false });
    }

    if (pathname === '/api/denuncias' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const tipoDenuncia = cleanText(body.tipo_denuncia, 20);
      const tipoViolencia = cleanText(body.tipo_violencia, 30).toLowerCase();
      const descricao = cleanText(body.descricao, 1000);

      if (!['anon', 'identified'].includes(tipoDenuncia)) return sendJson(res, 400, { erro: 'Tipo de denúncia inválido.' });
      if (!VIOLENCE_TYPES.has(tipoViolencia)) return sendJson(res, 400, { erro: 'Tipo de violência inválido.' });
      if (descricao.length < 10) return sendJson(res, 400, { erro: 'A descrição deve ter pelo menos 10 caracteres.' });

      const triagem = classifyTriage({ descricao, tipoViolencia });
      const result = insertDenuncia.run(
        tipoDenuncia, tipoViolencia, descricao,
        triagem.nivel, triagem.confianca, triagem.modelo
      );
      const registro = findDenuncia.get(Number(result.lastInsertRowid));
      return sendJson(res, 201, {
        id: registro.id,
        status: registro.status,
        criado_em: registro.criado_em,
        mensagem: 'Denúncia registrada com sucesso.'
      });
    }

    // Listagem pública foi removida por privacidade. Os dados completos exigem autorização administrativa.
    if (pathname === '/api/denuncias' && req.method === 'GET') {
      return sendJson(res, 403, { erro: 'Listagem restrita ao painel administrativo.' });
    }

    if (pathname === '/api/admin/denuncias' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      return sendJson(res, 200, listAdminDenuncias(url));
    }

    if (pathname === '/api/admin/analytics' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      return sendJson(res, 200, analytics());
    }

    if (pathname === '/api/admin/auditoria' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const rows = db.prepare(`
        SELECT au.id, au.criado_em, COALESCE(ad.email,'sistema') AS operador, au.acao, au.detalhes
        FROM auditoria au LEFT JOIN admins ad ON ad.id = au.admin_id
        ORDER BY au.id DESC LIMIT 200
      `).all();
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/admin/export.csv' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const rows = db.prepare(`
        SELECT id, tipo_denuncia, tipo_violencia, descricao, status,
               triagem_nivel, triagem_confianca, criado_em, atualizado_em
        FROM denuncias ORDER BY id
      `).all();
      audit(admin.id, 'EXPORTAR_DATASET', `${rows.length} registos exportados em CSV.`);
      return sendText(res, 200, buildCsv(rows), 'text/csv; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="acolhe_dataset_tratado.csv"'
      });
    }

    let match = pathname.match(/^\/api\/admin\/denuncias\/(\d+)\/status$/);
    if (match && req.method === 'PUT') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const id = Number(match[1]);
      const atual = findDenuncia.get(id);
      if (!atual) return sendJson(res, 404, { erro: 'Denúncia não encontrada.' });
      const body = await readJsonBody(req);
      const novoStatus = cleanText(body.status, 30);
      if (novoStatus === atual.status) return sendJson(res, 200, atual);
      if (!STATUS_TRANSITIONS[atual.status]?.includes(novoStatus)) {
        return sendJson(res, 400, {
          erro: `Transição não permitida: ${atual.status} → ${novoStatus}.`,
          permitidos: STATUS_TRANSITIONS[atual.status] || []
        });
      }
      db.prepare("UPDATE denuncias SET status = ?, atualizado_em = datetime('now','localtime') WHERE id = ?").run(novoStatus, id);
      audit(admin.id, 'ALTERAR_STATUS', `Denúncia #${id}: ${atual.status} → ${novoStatus}.`);
      return sendJson(res, 200, findDenuncia.get(id));
    }

    match = pathname.match(/^\/api\/admin\/denuncias\/(\d+)\/reclassificar$/);
    if (match && req.method === 'POST') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const id = Number(match[1]);
      const atual = findDenuncia.get(id);
      if (!atual) return sendJson(res, 404, { erro: 'Denúncia não encontrada.' });
      const t = classifyTriage(atual);
      db.prepare(`
        UPDATE denuncias SET triagem_nivel = ?, triagem_confianca = ?, triagem_modelo = ?, atualizado_em = datetime('now','localtime')
        WHERE id = ?
      `).run(t.nivel, t.confianca, t.modelo, id);
      audit(admin.id, 'RECLASSIFICAR_IA', `Denúncia #${id}: triagem ${t.nivel}.`);
      return sendJson(res, 200, { ...findDenuncia.get(id), triagem_aviso: t.aviso });
    }

    match = pathname.match(/^\/api\/admin\/denuncias\/(\d+)$/);
    if (match && req.method === 'DELETE') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const id = Number(match[1]);
      const atual = findDenuncia.get(id);
      if (!atual) return sendJson(res, 404, { erro: 'Denúncia não encontrada.' });
      db.prepare('DELETE FROM denuncias WHERE id = ?').run(id);
      audit(admin.id, 'EXCLUIR_DENUNCIA', `Denúncia #${id} excluída.`);
      return sendJson(res, 200, { mensagem: 'Denúncia excluída com sucesso.' });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { erro: 'Rota da API não encontrada.' });
    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { erro: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Acolhe MVP 2.0 rodando em http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`Banco SQLite: ${DB_PATH}`);
  console.log(`Admin local: ${ADMIN_EMAIL}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('ATENÇÃO: usando senha local padrão Acolhe@2026. Defina ADMIN_PASSWORD antes de publicar.');
  }
});
