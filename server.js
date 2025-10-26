// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const DB_FILE = path.join(__dirname, 'database.json');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || null;

const app = express();
app.use(cors());
app.use(express.json());

// --- util: read/write DB (síncrono simples) ---
function readDB(){
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(err) {
    // se não existir, cria base padrão
    const base = {
      config: {
        startTime: "07:00",
        endTime: "16:00",
        defaultDuration: 60,
        daysOfWeek: [1,2,3,4,5],
        blockedDates: [],
        adminPassword: "1234"
      },
      bookings: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(base, null, 2));
    return base;
  }
}
function writeDB(obj){
  fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2));
}

// --- util horário ---
function timeToMinutes(t){
  const [h,m] = t.split(':').map(n=>parseInt(n,10));
  return h*60 + m;
}
function minutesToTime(min){
  const h = Math.floor(min/60), m = min%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// --- auth middleware for admin routes ---
function requireAdmin(req, res, next){
  const db = readDB();
  const confPass = ADMIN_PASSWORD_ENV || (db.config && db.config.adminPassword) || '1234';
  const got = req.header('x-admin-password') || req.body.adminPassword || '';
  if(got && got === confPass){
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized (admin password required in header x-admin-password)'});
}

/*
API endpoints:

GET /config -> retorna config (público)
POST /config -> SALVAR config (admin)
GET /horarios?date=YYYY-MM-DD -> retorna slots disponíveis para a data (com occupied flag)
POST /agendar -> cria agendamento (body: name, phone, service, date, time, duration?, autoConfirm=true/false)
GET /agendamentos -> lista agendamentos (admin only)
GET /agendamentos/public?date=YYYY-MM-DD -> lista agendamentos públicos (phone removed)
PATCH /agendamentos/:id -> editar/confirmar (admin)
DELETE /agendamentos/:id -> remover (admin)
*/

app.get('/config', (req, res) => {
  const db = readDB();
  res.json(db.config || {});
});

app.post('/config', requireAdmin, (req, res) => {
  const db = readDB();
  const cfg = req.body;
  // validações básicas
  if(!cfg.startTime || !cfg.endTime || !cfg.defaultDuration) {
    return res.status(400).json({ error: 'startTime, endTime e defaultDuration são obrigatórios' });
  }
  db.config = {
    ...db.config,
    startTime: cfg.startTime,
    endTime: cfg.endTime,
    defaultDuration: parseInt(cfg.defaultDuration,10),
    daysOfWeek: Array.isArray(cfg.daysOfWeek) ? cfg.daysOfWeek.map(Number) : db.config.daysOfWeek,
    blockedDates: Array.isArray(cfg.blockedDates) ? cfg.blockedDates : db.config.blockedDates,
    adminPassword: cfg.adminPassword || db.config.adminPassword
  };
  writeDB(db);
  res.json({ ok: true, config: db.config });
});

// helper: check overlap
function overlaps(startA, durA, startB, durB){
  const a0 = timeToMinutes(startA), a1 = a0 + parseInt(durA,10);
  const b0 = timeToMinutes(startB), b1 = b0 + parseInt(durB,10);
  return Math.max(a0,b0) < Math.min(a1,b1);
}

/**
 * GET /horarios?date=YYYY-MM-DD
 * retorna array de { time: "HH:MM", duration, available: true/false }
 */
app.get('/horarios', (req, res) => {
  const date = req.query.date;
  if(!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

  const db = readDB();
  const cfg = db.config;

  // validar dia da semana / blockedDates
  const d = new Date(date + 'T00:00:00');
  if(isNaN(d)) return res.status(400).json({ error: 'Invalid date' });
  const dayOfWeek = d.getDay(); // 0..6
  if(cfg.blockedDates && cfg.blockedDates.includes(date)){
    return res.json({ date, slots: [], reason: 'blocked' });
  }
  if(!(cfg.daysOfWeek || []).includes(dayOfWeek)){
    return res.json({ date, slots: [], reason: 'no-service-day' });
  }

  // generate slots between start and end using defaultDuration
  const start = timeToMinutes(cfg.startTime);
  const end = timeToMinutes(cfg.endTime);
  const dur = parseInt(cfg.defaultDuration,10);
  const slots = [];
  for(let t = start; t + dur <= end; t += dur){
    slots.push({ time: minutesToTime(t), duration: dur });
  }

  // mark occupied by bookings on that date (status != 'cancelled')
  const bookings = (db.bookings || []).filter(b => b.data === date && b.status !== 'cancelled');

  const slotsWithAvailability = slots.map(s => {
    const busy = bookings.some(b => overlaps(s.time, s.duration, b.hora, b.duration || s.duration));
    return { time: s.time, duration: s.duration, available: !busy };
  });

  res.json({ date, slots: slotsWithAvailability });
});

/**
 * POST /agendar
 * body: { nome, telefone, servico, data, hora, duration?, autoConfirm? }
 * If autoConfirm === false -> status 'pending'
 * Else -> status 'confirmed' if no collision
 */
app.post('/agendar', (req, res) => {
  const { nome, telefone, servico, data, hora } = req.body;
  let duration = req.body.duration;
  const autoConfirm = req.body.autoConfirm !== false; // default true

  if(!nome || !data || !hora) return res.status(400).json({ error: 'nome, data e hora são obrigatórios' });

  const db = readDB();
  const cfg = db.config;
  duration = duration ? parseInt(duration,10) : cfg.defaultDuration;

  // check day allowed
  const dObj = new Date(data + 'T00:00:00');
  if(isNaN(dObj)) return res.status(400).json({ error: 'data inválida' });
  const dow = dObj.getDay();
  if(cfg.blockedDates && cfg.blockedDates.includes(data)) return res.status(400).json({ error: 'Data bloqueada' });
  if(!(cfg.daysOfWeek || []).includes(dow)) {
    return res.status(400).json({ error: 'Dia sem atendimento' });
  }

  // check that desired time exists in the generated range (optional) and check collisions
  const startMin = timeToMinutes(cfg.startTime);
  const endMin = timeToMinutes(cfg.endTime);
  const reqMin = timeToMinutes(hora);
  if(reqMin < startMin || (reqMin + duration) > endMin){
    return res.status(400).json({ error: 'Horário fora do expediente configurado' });
  }

  // check collisions with existing confirmed or pending (we reserve check for confirmed as needed)
  const collisions = (db.bookings || []).some(b => {
    if(b.data !== data) return false;
    if(b.status === 'cancelled') return false;
    return overlaps(hora, duration, b.hora, b.duration || cfg.defaultDuration);
  });

  const newBooking = {
    id: uuidv4(),
    nome,
    telefone: telefone || '',
    servico: servico || '',
    data,
    hora,
    duration,
    status: autoConfirm ? (collisions ? 'pending' : 'confirmed') : 'pending',
    createdAt: new Date().toISOString()
  };

  db.bookings.push(newBooking);
  writeDB(db);

  return res.json({ ok: true, booking: newBooking, collisions });
});

/**
 * GET /agendamentos
 * admin only -> retorna todos os bookings (com telefone)
 */
app.get('/agendamentos', requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.bookings || []);
});

/**
 * GET /agendamentos/public?date=YYYY-MM-DD
 * retorna bookings com telefone omitido (para visualização pública)
 */
app.get('/agendamentos/public', (req, res) => {
  const date = req.query.date;
  const db = readDB();
  let items = db.bookings || [];
  if(date) items = items.filter(b => b.data === date);
  const safe = items.map(b => ({
    id: b.id,
    nome: b.nome,
    servico: b.servico,
    data: b.data,
    hora: b.hora,
    duration: b.duration,
    status: b.status,
    createdAt: b.createdAt,
    telefone: b.telefone ? '— (contato apenas para admin)' : ''
  }));
  res.json(safe);
});

/**
 * PATCH /agendamentos/:id (admin)
 * body: fields to change: status, nome, telefone, data, hora, duration
 */
app.patch('/agendamentos/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === id);
  if(idx === -1) return res.status(404).json({ error: 'not found' });
  const allow = ['status','nome','telefone','data','hora','duration','servico'];
  allow.forEach(k => {
    if(req.body[k] !== undefined) db.bookings[idx][k] = req.body[k];
  });
  db.bookings[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  res.json({ ok: true, booking: db.bookings[idx] });
});

/**
 * DELETE /agendamentos/:id (admin)
 */
app.delete('/agendamentos/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const db = readDB();
  const before = db.bookings.length;
  db.bookings = db.bookings.filter(b => b.id !== id);
  writeDB(db);
  res.json({ ok: true, deleted: before - db.bookings.length });
});

/**
 * Optional: get full DB (admin)
 */
app.get('/dump', requireAdmin, (req, res) => {
  res.sendFile(DB_FILE);
});

// start
app.listen(PORT, ()=> {
  console.log(`Kátia agenda backend running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});