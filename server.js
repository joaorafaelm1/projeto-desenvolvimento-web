const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'acolhe.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS denuncias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_denuncia TEXT NOT NULL CHECK (tipo_denuncia IN ('anon', 'identified')),
    tipo_violencia TEXT NOT NULL,
    descricao TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Recebida',
    criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

const insertDenuncia = db.prepare(`
  INSERT INTO denuncias (tipo_denuncia, tipo_violencia, descricao)
  VALUES (?, ?, ?)
`);

const listDenuncias = db.prepare(`
  SELECT id, tipo_denuncia, tipo_violencia, descricao, status, criado_em
  FROM denuncias
  ORDER BY id DESC
`);

const findDenuncia = db.prepare(`
  SELECT id, tipo_denuncia, tipo_violencia, descricao, status, criado_em
  FROM denuncias
  WHERE id = ?
`);

const updateDenuncia = db.prepare(`
  UPDATE denuncias
  SET tipo_violencia = ?, descricao = ?, status = ?
  WHERE id = ?
`);

const deleteDenuncia = db.prepare(`DELETE FROM denuncias WHERE id = ?`);

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
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
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Acesso negado.');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado.');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, banco: 'SQLite', arquivo: 'acolhe.db' });
    }

    if (pathname === '/api/denuncias' && req.method === 'GET') {
      return sendJson(res, 200, listDenuncias.all());
    }

    if (pathname === '/api/denuncias' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const tipoDenuncia = body.tipo_denuncia;
      const tipoViolencia = String(body.tipo_violencia || '').trim();
      const descricao = String(body.descricao || '').trim();

      if (!['anon', 'identified'].includes(tipoDenuncia)) {
        return sendJson(res, 400, { erro: 'Tipo de denúncia inválido.' });
      }
      if (!tipoViolencia) {
        return sendJson(res, 400, { erro: 'Informe o tipo de violência.' });
      }
      if (!descricao || descricao.length > 1000) {
        return sendJson(res, 400, { erro: 'A descrição deve ter entre 1 e 1000 caracteres.' });
      }

      const result = insertDenuncia.run(tipoDenuncia, tipoViolencia, descricao);
      const registro = findDenuncia.get(Number(result.lastInsertRowid));
      return sendJson(res, 201, registro);
    }

    const match = pathname.match(/^\/api\/denuncias\/(\d+)$/);
    if (match && req.method === 'PUT') {
      const id = Number(match[1]);
      const atual = findDenuncia.get(id);
      if (!atual) return sendJson(res, 404, { erro: 'Denúncia não encontrada.' });

      const body = await readJsonBody(req);
      const tipoViolencia = String(body.tipo_violencia ?? atual.tipo_violencia).trim();
      const descricao = String(body.descricao ?? atual.descricao).trim();
      const status = String(body.status ?? atual.status).trim();
      const statusPermitidos = ['Recebida', 'Em análise', 'Concluída'];

      if (!tipoViolencia || !descricao || descricao.length > 1000) {
        return sendJson(res, 400, { erro: 'Dados de atualização inválidos.' });
      }
      if (!statusPermitidos.includes(status)) {
        return sendJson(res, 400, { erro: 'Status inválido.' });
      }

      updateDenuncia.run(tipoViolencia, descricao, status, id);
      return sendJson(res, 200, findDenuncia.get(id));
    }

    if (match && req.method === 'DELETE') {
      const id = Number(match[1]);
      const atual = findDenuncia.get(id);
      if (!atual) return sendJson(res, 404, { erro: 'Denúncia não encontrada.' });
      deleteDenuncia.run(id);
      return sendJson(res, 200, { mensagem: 'Denúncia excluída com sucesso.' });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { erro: 'Rota da API não encontrada.' });
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { erro: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Acolhe MVP rodando em http://localhost:${PORT}`);
  console.log(`Painel CRUD: http://localhost:${PORT}/admin.html`);
  console.log(`Banco SQLite: ${DB_PATH}`);
});
