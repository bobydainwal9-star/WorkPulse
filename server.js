require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for the hosted deployment.');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 5 });
const QR_TTL_MS = 60_000;
const ALLOWED_CIDRS = (process.env.ALLOWED_CIDRS || '')
  .split(',').map(x => x.trim()).filter(Boolean);

app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust the single platform proxy for the client IP.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false }));
app.use('/api/attendance/scan', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));


function todayLocal() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function clockLocal() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function seedDb() {
  const users = [{ id:'ADMIN', name:'Administrator', dept:'Administration', email:ADMIN_EMAIL, role:'Admin', passwordHash:bcrypt.hashSync(ADMIN_PASSWORD, 12) }];
  return { users, attendance: [], qrTokens: [], audit: [], networkConfig: { allowedCidrs: ALLOWED_CIDRS } };
}
let db;
let writeQueue = Promise.resolve();
async function initDb() {
  if (JWT_SECRET.length < 32 || !ADMIN_EMAIL || ADMIN_PASSWORD.length < 12) throw new Error('Set JWT_SECRET (32+ chars), ADMIN_EMAIL, and ADMIN_PASSWORD (12+ chars) in Render environment variables.');
  await pool.query(`CREATE TABLE IF NOT EXISTS workpulse_store (id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  const result = await pool.query('SELECT data FROM workpulse_store WHERE id = 1');
  if (result.rowCount) {
    db = result.rows[0].data;
    db.users ||= []; db.attendance ||= []; db.qrTokens ||= []; db.audit ||= [];
    db.networkConfig ||= { allowedCidrs: ALLOWED_CIDRS };
    if (!db.users.some(u => u.email.toLowerCase() === ADMIN_EMAIL)) db.users.push({ id:'ADMIN', name:'Administrator', dept:'Administration', email:ADMIN_EMAIL, role:'Admin', passwordHash:bcrypt.hashSync(ADMIN_PASSWORD, 12) });
    await saveDb();
  } else {
    db = seedDb();
    await pool.query('INSERT INTO workpulse_store (id, data) VALUES (1, $1::jsonb)', [JSON.stringify(db)]);
  }
}
function saveDb() {
  const snapshot = JSON.stringify(db);
  writeQueue = writeQueue.then(() => pool.query('UPDATE workpulse_store SET data = $1::jsonb, updated_at = now() WHERE id = 1', [snapshot]));
  return writeQueue;
}
function audit(actor, action, record, details, ip) {
  db.audit.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, record: String(record || ''), details: String(details || ''), ip: String(ip || '') });
  db.audit = db.audit.slice(0, 3000);
}
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).replace(/^::ffff:/i, '').split('%')[0];
  if (s === '::1') return '127.0.0.1';
  return s;
}
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
}
function ipAllowed(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? (net.includes(':') ? 128 : 32) : Number(bitsRaw);
  const a = ipv4ToInt(ip), b = ipv4ToInt(net);
  if (a !== null && b !== null) {
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  // Exact IPv6 matching is supported; configure IPv4 CIDRs for typical office Wi-Fi.
  return ip.toLowerCase() === net.toLowerCase() && bits === 128;
}
function getClientIp(req) { return normalizeIp(req.ip || req.socket.remoteAddress || ''); }
async function requireNetwork(req, res, next) {
  const ip = getClientIp(req);
  const approvedCidrs = db.networkConfig?.allowedCidrs || ALLOWED_CIDRS;
  if (!approvedCidrs.some(cidr => ipAllowed(ip, cidr))) {
    audit(req.user?.email || 'Unknown', 'Attendance network rejected', req.user?.id || '', `Client IP ${ip} not in approved CIDRs (${approvedCidrs.join(', ')})`, ip);
    await saveDb();
    return res.status(403).json({ error: 'This device is not connected to the approved company network.', code: 'NETWORK_NOT_ALLOWED' });
  }
  req.clientIp = ip;
  next();
}
function auth(req, res, next) {
  const value = req.headers.authorization || '';
  const token = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please sign in again.' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === claims.id && u.active !== false);
    if (!user) return res.status(401).json({ error: 'Account is unavailable.' });
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role || 'Employee', dept: user.dept || '' };
    next();
  } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
}
function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to perform this action.' });
}
function safeUser(u) { return { id: u.id, name: u.name, email: u.email, dept: u.dept, role: u.role || 'Employee' }; }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'WorkPulse Attendance API', qrTtlSeconds: 60 }));
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.email.toLowerCase() === email && u.active !== false);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  audit(user.email, 'Login successful', user.id, `Role: ${user.role}`, getClientIp(req));
  await saveDb();
  res.json({ token, user: safeUser(user), expiresIn: 43200 });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

app.post('/api/admin/employees', auth, allowRoles('Admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const dept = String(req.body.dept || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'Manager' ? 'Manager' : 'Employee';
  if (!name || !dept || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return res.status(400).json({ error: 'Enter a name, department, valid email, and password of at least 6 characters.' });
  if (db.users.some(u => u.email.toLowerCase() === email)) return res.status(409).json({ error: 'This email is already registered on the server.' });
  const employeeIds = db.users.filter(u => /^EMP\d+$/.test(u.id)).map(u => Number(u.id.slice(3)));
  const id = 'EMP' + String(Math.max(0, ...employeeIds) + 1).padStart(3, '0');
  const user = { id, name, dept, email, role, passwordHash: await bcrypt.hash(password, 10) };
  db.users.push(user); audit(req.user.email, 'Employee created', id, `${name} (${role})`, getClientIp(req)); await saveDb();
  res.status(201).json({ user: safeUser(user) });
});
app.get('/api/admin/employees', auth, allowRoles('Admin'), async (_req, res) => res.json({ users: db.users.map(safeUser) }));
app.get('/api/admin/network', auth, allowRoles('Admin'), async (req, res) => {
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const ipv4 = interfaces.filter(x => x.family === 'IPv4' && !x.internal).map(x => ({ address: x.address, netmask: x.netmask }));
  res.json({ allowedCidrs: db.networkConfig.allowedCidrs || ALLOWED_CIDRS, detectedClientIp: getClientIp(req), serverIPv4: ipv4 });
});
function validCidr(value) {
  const [address, prefixText] = String(value).trim().split('/');
  const prefix = prefixText === undefined ? (address.includes(':') ? 128 : 32) : Number(prefixText);
  const ipInt = ipv4ToInt(address);
  if (ipInt !== null) return Number.isInteger(prefix) && prefix >= 16 && prefix <= 32;
  // This demo accepts exact IPv6 addresses only; IPv6 CIDR range matching is not implemented.
  return address.includes(':') && prefix === 128 && /^[0-9a-f:]+$/i.test(address);
}
app.put('/api/admin/network', auth, allowRoles('Admin'), async (req, res) => {
  const raw = Array.isArray(req.body.allowedCidrs) ? req.body.allowedCidrs : String(req.body.allowedCidrs || '').split(',');
  const cidrs = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
  if (!cidrs.length || cidrs.length > 20 || cidrs.some(x => !validCidr(x))) {
    return res.status(400).json({ error: 'Enter 1–20 valid network ranges. For IPv4, use a subnet such as 192.168.1.0/24 (prefix /16 to /32).' });
  }
  if (cidrs.includes('0.0.0.0/0') || cidrs.includes('::/0')) return res.status(400).json({ error: 'A rule that allows every network is not permitted.' });
  const previous = (db.networkConfig.allowedCidrs || ALLOWED_CIDRS).join(', ');
  db.networkConfig = { allowedCidrs: cidrs, updatedAt: new Date().toISOString(), updatedBy: req.user.email };
  audit(req.user.email, 'Attendance network updated', 'Network allow-list', `From [${previous}] to [${cidrs.join(', ')}]`, getClientIp(req));
  await saveDb();
  res.json({ message: 'Attendance network rules saved.', allowedCidrs: cidrs });
});

app.post('/api/attendance/qr', auth, allowRoles('Admin', 'Manager'), async (req, res) => {
  const now = Date.now();
  db.qrTokens = db.qrTokens.filter(t => t.expiresAt > now - 60_000);
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + QR_TTL_MS;
  db.qrTokens.push({ token, createdAt: now, expiresAt, createdBy: req.user.id, usedAt: null });
  // Prefer an explicitly configured public base URL. If the admin opened localhost,
  // replace it with a server LAN IPv4 address so a phone does not receive a localhost QR.
  const configuredBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  const requestHost = String(req.get('host') || '');
  const requestHostname = requestHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  let baseUrl = configuredBase || `${req.protocol}://${requestHost}`;
  if (!configuredBase && ['localhost', '127.0.0.1', '::1'].includes(requestHostname)) {
    const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
    const candidates = interfaces.filter(x => x.family === 'IPv4' && !x.internal).map(x => x.address);
    const preferred = candidates.find(address => (db.networkConfig?.allowedCidrs || ALLOWED_CIDRS).some(cidr => ipAllowed(address, cidr))) || candidates[0];
    if (preferred) baseUrl = `${req.protocol}://${preferred}:${PORT}`;
  }
  const scanUrl = `${baseUrl}/scan?token=${encodeURIComponent(token)}`;
  const qrDataUrl = await QRCode.toDataURL(scanUrl, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#17233d', light: '#ffffff' } });
  await saveDb();
  res.json({ qrDataUrl, scanUrl, token, expiresAt, ttlSeconds: 60 });
});
app.get('/api/attendance/today', auth, async (req, res) => {
  const today = todayLocal();
  const records = db.attendance.filter(a => a.date === today && (req.user.role !== 'Employee' || a.employeeId === req.user.id));
  const users = new Map(db.users.map(u => [u.id, safeUser(u)]));
  res.json({ date: today, records: records.map(a => ({ ...a, employee: users.get(a.employeeId) || { id:a.employeeId, name:'Unknown employee' } })), users: req.user.role === 'Employee' ? [safeUser(db.users.find(u => u.id === req.user.id))] : db.users.filter(u => u.role !== 'Admin').map(safeUser) });
});
app.get('/api/attendance/history', auth, async (req, res) => {
  const records = db.attendance.filter(a => req.user.role !== 'Employee' || a.employeeId === req.user.id).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const users = new Map(db.users.map(u => [u.id, safeUser(u)]));
  res.json({ records: records.map(a => ({ ...a, employee: users.get(a.employeeId) || { id:a.employeeId, name:'Unknown employee' } })) });
});
app.post('/api/attendance/scan', auth, allowRoles('Employee', 'Manager'), requireNetwork, async (req, res) => {
  const token = String(req.body.token || '');
  const now = Date.now();
  const qr = db.qrTokens.find(t => t.token === token);
  if (!qr) return res.status(400).json({ error: 'QR code is invalid. Scan the currently displayed code.', code: 'QR_INVALID' });
  if (qr.expiresAt < now) return res.status(410).json({ error: 'This QR code has expired. Scan the latest code.', code: 'QR_EXPIRED' });
  const date = todayLocal();
  const existing = db.attendance.find(a => a.employeeId === req.user.id && a.date === date);
  if (existing?.checkIn) return res.status(409).json({ error: `You have already checked in today at ${existing.checkIn}.`, code: 'ALREADY_CHECKED_IN', record: existing });
  const time = clockLocal();
  const record = existing || { id: crypto.randomUUID(), employeeId: req.user.id, date, checkIn: null, checkOut: null, status: 'Present', createdAt: new Date().toISOString() };
  record.checkIn = time; record.status = 'Present'; record.checkInIp = req.clientIp; record.qrTokenId = token.slice(0, 8); record.updatedAt = new Date().toISOString();
  if (!existing) db.attendance.push(record);
  qr.usedAt = now;
  audit(req.user.email, 'QR check-in accepted', record.id, `Date ${date}; time ${time}; network verified`, req.clientIp);
  await saveDb();
  res.json({ message: `Check-in successful. Welcome, ${req.user.name}.`, record });
});
app.post('/api/attendance/checkout', auth, allowRoles('Employee', 'Manager'), requireNetwork, async (req, res) => {
  const date = todayLocal();
  const record = db.attendance.find(a => a.employeeId === req.user.id && a.date === date);
  if (!record?.checkIn) return res.status(400).json({ error: 'You need to check in before checking out.' });
  if (record.checkOut) return res.status(409).json({ error: `You already checked out at ${record.checkOut}.` });
  record.checkOut = clockLocal(); record.updatedAt = new Date().toISOString(); record.checkOutIp = req.clientIp;
  audit(req.user.email, 'Check-out accepted', record.id, `Date ${date}; time ${record.checkOut}; network verified`, req.clientIp); await saveDb();
  res.json({ message: `Check-out successful at ${record.checkOut}.`, record });
});
app.get('/api/admin/attendance/today', auth, allowRoles('Admin', 'Manager'), async (req, res) => {
  const today = todayLocal();
  const users = db.users.filter(u => u.role !== 'Admin');
  const records = db.attendance.filter(a => a.date === today);
  res.json({ date: today, users: users.map(safeUser), records: records.map(a => ({ ...a, employee: safeUser(db.users.find(u => u.id === a.employeeId) || { id:a.employeeId, name:'Unknown', email:'', role:'Employee' }) })) });
});
app.get('/api/admin/audit', auth, allowRoles('Admin'), async (req, res) => res.json({ audit: db.audit.slice(0, 500) }));

app.get('/scan', (_req, res) => res.sendFile(path.join(__dirname, 'scan.html')));
app.get('/scan.html', (_req, res) => res.redirect('/scan'));
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny', setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDb().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`WorkPulse hosted server listening on ${PORT}`);
    console.log(`Attendance allow-list: ${(db.networkConfig?.allowedCidrs || ALLOWED_CIDRS).join(', ') || '(not configured — attendance is blocked)'}`);

  });
}).catch(err => { console.error('Database startup failed:', err); process.exit(1); });

process.on('SIGTERM', async () => { try { await writeQueue; await pool.end(); } finally { process.exit(0); } });
