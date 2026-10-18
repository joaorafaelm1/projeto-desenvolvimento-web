'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3217;
const DB = path.join(__dirname, '.smoke-test.db');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch {} }

const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: DB,
    ADMIN_EMAIL: 'teste@acolhe.local',
    ADMIN_PASSWORD: 'SenhaTeste@2026'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => process.stdout.write(String(d)));
child.stderr.on('data', d => process.stderr.write(String(d)));

const base = `http://127.0.0.1:${PORT}`;
let cookie = '';

function assert(condition, message) {
  if (!condition) throw new Error(`FALHOU: ${message}`);
  console.log(`OK: ${message}`);
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

async function json(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, { ...options, headers });
  const data = await res.json();
  return { res, data };
}

(async () => {
  try {
    await waitServer();

    let x = await json('/api/health');
    assert(x.res.ok && x.data.ia, 'health informa banco, autenticação, dashboard e IA');

    x = await json('/api/denuncias', { method:'POST', body: JSON.stringify({
      tipo_denuncia:'anon', tipo_violencia:'fisica', descricao:'Ele está aqui na porta agora e ameaçou me matar com uma faca.'
    })});
    assert(x.res.status === 201 && x.data.id, 'cadastro público de denúncia funciona');
    const id = x.data.id;

    x = await json('/api/admin/denuncias');
    assert(x.res.status === 401, 'rota administrativa é protegida');

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:'teste@acolhe.local', senha:'SenhaTeste@2026' })
    });
    const loginData = await loginRes.json();
    cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    assert(loginRes.ok && loginData.ok && cookie.includes('acolhe_session='), 'login administrativo cria sessão');

    x = await json('/api/admin/denuncias');
    assert(x.res.ok && x.data.length === 1 && x.data[0].triagem_nivel === 'Urgente', 'listagem protegida e triagem IA integrada');

    x = await json('/api/admin/analytics');
    assert(x.res.ok && x.data.total === 1 && x.data.porTipo.length === 1, 'dashboard analítico usa dados reais');

    x = await json(`/api/admin/denuncias/${id}/status`, { method:'PUT', body: JSON.stringify({ status:'Em análise' }) });
    assert(x.res.ok && x.data.status === 'Em análise', 'regra de negócio Recebida → Em análise funciona');

    x = await json(`/api/admin/denuncias/${id}/status`, { method:'PUT', body: JSON.stringify({ status:'Recebida' }) });
    assert(x.res.status === 400, 'regra impede retrocesso de status');

    const csvRes = await fetch(`${base}/api/admin/export.csv`, { headers:{Cookie:cookie} });
    const csv = await csvRes.text();
    assert(csvRes.ok && csv.includes('tipo_violencia') && csv.includes('fisica'), 'exportação do dataset tratado funciona');

    x = await json('/api/admin/auditoria');
    assert(x.res.ok && x.data.some(r => r.acao === 'ALTERAR_STATUS'), 'auditoria registra ações administrativas');

    x = await json(`/api/admin/denuncias/${id}`, { method:'DELETE', body:'{}' });
    assert(x.res.ok, 'exclusão administrativa funciona');

    console.log('\nTODOS OS TESTES PRINCIPAIS PASSARAM.');
  } catch (err) {
    console.error(err.stack || err);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => {
      for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch {} }
    }, 250);
  }
})();
