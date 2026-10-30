import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const CREATE_REQUIRES_KEY = process.env.CREATE_REQUIRES_KEY === 'true';
const IP_SALT = process.env.IP_SALT || 'dev-salt';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const RESERVED = new Set(['api', 'health', 'admin', 'static', 'index', 'favicon']);
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_RE = /^[0-9A-Za-z_-]{3,32}$/;

// ---------- helpers ----------
const genCode = (len = 6) =>
  Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');

const baseUrl = (req) =>
  (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const hashIp = (ip) =>
  crypto.createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 16);

const parseDevice = (ua) =>
  /ipad|tablet/i.test(ua) ? 'tablet' : /mobi|android|iphone/i.test(ua) ? 'mobile' : 'desktop';

const parseBrowser = (ua) =>
  /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera'
  : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox'
  : /safari/i.test(ua) ? 'Safari' : 'Outro';

const isBot = (ua) => /bot|crawl|spider|preview|facebookexternalhit|slurp|curl|wget/i.test(ua);

const fail = (res, status, message) => res.status(status).json({ error: message });

const requireKey = (req, res, next) => {
  if (!API_KEY) return fail(res, 403, 'Rota administrativa desativada: defina API_KEY no .env');
  if (req.get('x-api-key') !== API_KEY) return fail(res, 401, 'API key inválida');
  next();
};

// ---------- statements ----------
const getLink = db.prepare('SELECT * FROM links WHERE code = ?');
const insertLink = db.prepare('INSERT INTO links (code, url, created_at, expires_at) VALUES (?, ?, ?, ?)');
const insertClick = db.prepare(
  'INSERT INTO clicks (code, clicked_at, referrer, device, browser, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
);
const bumpClicks = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?');
const registerClick = db.transaction((code, d) => {
  insertClick.run(code, new Date().toISOString(), d.referrer, d.device, d.browser, d.ip);
  bumpClicks.run(code);
});

// ---------- app ----------
const app = express();
app.set('trust proxy', 1); // necessário atrás do proxy de Render/Railway/Fly
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', cors({ origin: CORS_ORIGIN.includes('*') ? '*' : CORS_ORIGIN }));

const createLimiter = rateLimit({
  windowMs: 60_000, limit: Number(process.env.RATE_LIMIT) || 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
});

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Criar link curto
app.post('/api/links', createLimiter,
  (req, res, next) => (CREATE_REQUIRES_KEY ? requireKey(req, res, next) : next()),
  (req, res) => {
    const { url, alias, expiresAt } = req.body ?? {};
    let parsed;
    try { parsed = new URL(url); } catch { return fail(res, 400, 'URL inválida. Inclua http:// ou https://'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return fail(res, 400, 'Apenas http e https são aceitos');
    if (parsed.href.length > 2048) return fail(res, 400, 'URL muito longa (máx. 2048)');
    if (parsed.host === req.get('host')) return fail(res, 400, 'Não é possível encurtar um link deste próprio serviço');

    let expires = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d) || d <= new Date()) return fail(res, 400, 'expiresAt deve ser uma data futura (ISO 8601)');
      expires = d.toISOString();
    }

    let code = alias;
    if (code !== undefined && code !== '') {
      if (!CODE_RE.test(code)) return fail(res, 400, 'Alias: 3 a 32 caracteres (letras, números, - e _)');
      if (RESERVED.has(code.toLowerCase())) return fail(res, 400, 'Alias reservado');
      if (getLink.get(code)) return fail(res, 409, 'Este alias já está em uso');
    } else {
      for (let i = 0; i < 5; i++) { code = genCode(); if (!getLink.get(code)) break; }
    }

    const createdAt = new Date().toISOString();
    insertLink.run(code, parsed.href, createdAt, expires);
    const b = baseUrl(req);
    res.status(201).json({
      code, url: parsed.href, shortUrl: `${b}/${code}`,
      statsUrl: `${b}/api/links/${code}/stats`, createdAt, expiresAt: expires,
    });
  });

// Estatísticas de um link
app.get('/api/links/:code/stats', (req, res) => {
  const link = getLink.get(req.params.code);
  if (!link) return fail(res, 404, 'Link não encontrado');
  const code = link.code;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const group = (col) =>
    db.prepare(`SELECT COALESCE(${col}, 'direto/desconhecido') AS name, COUNT(*) AS clicks
                FROM clicks WHERE code = ? GROUP BY name ORDER BY clicks DESC LIMIT 5`).all(code);

  res.json({
    code, url: link.url, createdAt: link.created_at, expiresAt: link.expires_at,
    totalClicks: link.clicks,
    uniqueVisitors: db.prepare('SELECT COUNT(DISTINCT ip_hash) AS n FROM clicks WHERE code = ?').get(code).n,
    clicksByDay: db.prepare(
      `SELECT substr(clicked_at,1,10) AS date, COUNT(*) AS clicks FROM clicks
       WHERE code = ? AND clicked_at >= ? GROUP BY date ORDER BY date`).all(code, since),
    topReferrers: group('referrer'),
    devices: group('device'),
    browsers: group('browser'),
    recentClicks: db.prepare(
      'SELECT clicked_at AS at, referrer, device, browser FROM clicks WHERE code = ? ORDER BY id DESC LIMIT 10').all(code),
  });
});

// Admin: listar e deletar (exigem API_KEY)
app.get('/api/links', requireKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const b = baseUrl(req);
  res.json(db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT ?').all(limit)
    .map((l) => ({ ...l, shortUrl: `${b}/${l.code}` })));
});

app.delete('/api/links/:code', requireKey, (req, res) => {
  const r = db.prepare('DELETE FROM links WHERE code = ?').run(req.params.code);
  if (!r.changes) return fail(res, 404, 'Link não encontrado');
  res.status(204).end();
});

app.use('/api', (_req, res) => fail(res, 404, 'Rota não encontrada'));

// Front-end de demonstração
app.use(express.static(path.join(__dirname, '..', 'public')));

// Redirecionamento (precisa ficar por último)
app.get('/:code', (req, res, next) => {
  if (!CODE_RE.test(req.params.code)) return next();
  const link = getLink.get(req.params.code);
  if (!link) return res.status(404).type('text').send('Link não encontrado :(');
  if (link.expires_at && new Date(link.expires_at) < new Date())
    return res.status(410).type('text').send('Este link expirou.');

  const ua = req.get('user-agent') || '';
  if (!isBot(ua)) {
    let referrer = null;
    try { referrer = new URL(req.get('referer')).hostname; } catch {}
    registerClick(link.code, {
      referrer, device: parseDevice(ua), browser: parseBrowser(ua), ip: hashIp(req.ip || ''),
    });
  }
  res.redirect(302, link.url); // 302: o navegador não cacheia, então todo clique é contado
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'JSON inválido');
  console.error(err);
  fail(res, 500, 'Erro interno');
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`🔗 ShortLink rodando em http://localhost:${PORT}`));
}
