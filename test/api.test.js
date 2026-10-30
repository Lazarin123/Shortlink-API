import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = './data/test.db';
process.env.API_KEY = 'testkey';
const { default: app } = await import('../src/server.js');

let server, base;
before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); }); }));
after(() => server.close());

const post = (body) => fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('cria, redireciona, conta clique e mostra stats', async () => {
  const alias = 't' + Date.now();
  const r = await post({ url: 'https://example.com/a?b=1', alias });
  assert.equal(r.status, 201);
  const red = await fetch(`${base}/${alias}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 Chrome', referer: 'https://twitter.com/x' } });
  assert.equal(red.status, 302);
  assert.equal(red.headers.get('location'), 'https://example.com/a?b=1');
  const s = await (await fetch(`${base}/api/links/${alias}/stats`)).json();
  assert.equal(s.totalClicks, 1);
  assert.equal(s.topReferrers[0].name, 'twitter.com');
});

test('rejeita URL inválida, alias duplicado e rota admin sem chave', async () => {
  assert.equal((await post({ url: 'javascript:alert(1)' })).status, 400);
  const alias = 'dup' + Date.now();
  await post({ url: 'https://example.com', alias });
  assert.equal((await post({ url: 'https://example.com', alias })).status, 409);
  assert.equal((await fetch(`${base}/api/links`)).status, 401);
  assert.equal((await fetch(`${base}/api/links`, { headers: { 'x-api-key': 'testkey' } })).status, 200);
});
