const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const readline = require('readline');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API : liste les fichiers du dossier troll ────────────────────────────────
app.get('/api/trollmedia', (req, res) => {
  const base = path.join(__dirname, 'public', 'trollmedia');
  const result = { images: [], videos: [], sounds: [] };
  for (const cat of ['images', 'videos', 'sounds']) {
    const dir = path.join(base, cat);
    if (fs.existsSync(dir)) {
      result[cat] = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    }
  }
  res.json(result);
});

// ─── Game State ───────────────────────────────────────────────────────────────
let state = {
  phase: 'lobby',
  players: {},
  round: 0,
  totalRounds: 3,
  chains: {},
  assignments: {},
  pending: new Set(),
  timer: null,
  timeLeft: 0,
  timerDuration: 80,
};

let nextId = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const p of Object.values(state.players)) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function playerList() {
  return Object.values(state.players).map(p => ({
    id: p.id, name: p.name, score: p.score, ready: p.ready
  }));
}

function broadcastLobby() {
  broadcast({ type: 'lobby', players: playerList(), phase: state.phase });
}

function startTimer(seconds, onEnd) {
  state.timeLeft = seconds;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    state.timeLeft--;
    broadcast({ type: 'timer', timeLeft: state.timeLeft });
    if (state.timeLeft <= 0) {
      clearInterval(state.timer);
      onEnd();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timer);
  broadcast({ type: 'timer', timeLeft: 0 });
}

function findPlayer(nameOrId) {
  return Object.values(state.players).find(
    p => p.name.toLowerCase() === nameOrId.toLowerCase() || p.id === nameOrId
  );
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function startGame() {
  const ids = Object.keys(state.players);
  if (ids.length < 2) return log('❌ Il faut au moins 2 joueurs !');

  state.phase = 'playing';
  state.round = 1;
  state.chains = {};
  state.assignments = {};

  for (const id of ids) {
    state.chains[id] = [];
    state.assignments[id] = id;
  }

  broadcast({ type: 'phase', phase: 'playing', round: state.round, totalRounds: state.totalRounds * ids.length });
  sendRoundPrompts();
}

function sendRoundPrompts() {
  const ids = Object.keys(state.players);
  state.pending = new Set(ids);
  const isWord = state.round % 2 === 1;

  for (const id of ids) {
    const p = state.players[id];
    const chainOwner = state.assignments[id];
    const chain = state.chains[chainOwner];
    const lastEntry = chain[chain.length - 1] || null;

    send(p.ws, {
      type: 'your_turn',
      round: state.round,
      taskType: isWord ? 'word' : 'drawing',
      prompt: lastEntry ? lastEntry.content : null,
      promptType: lastEntry ? lastEntry.type : null,
      chainOwner: state.players[chainOwner]?.name || '?',
      timerDuration: state.timerDuration,
    });
  }

  startTimer(state.timerDuration, () => {
    for (const id of [...state.pending]) {
      const isWord = state.round % 2 === 1;
      receiveSubmission(id, isWord ? '???' : null, true);
    }
  });
}

function receiveSubmission(playerId, content, forced = false) {
  if (!state.pending.has(playerId)) return;
  state.pending.delete(playerId);

  const chainOwner = state.assignments[playerId];
  const isWord = state.round % 2 === 1;

  state.chains[chainOwner].push({
    type: isWord ? 'word' : 'drawing',
    content,
    author: state.players[playerId]?.name || '?',
    forced,
  });

  send(state.players[playerId]?.ws, { type: 'submitted', waiting: state.pending.size });
  for (const [id, p] of Object.entries(state.players)) {
    if (id !== playerId) {
      send(p.ws, { type: 'waiting_update', waiting: state.pending.size, name: state.players[playerId]?.name });
    }
  }

  if (state.pending.size === 0) {
    stopTimer();
    advanceRound();
  }
}

function advanceRound() {
  const ids = Object.keys(state.players);
  const maxRounds = state.totalRounds * ids.length;

  if (state.round >= maxRounds) {
    showResults();
    return;
  }

  state.round++;
  const newAssignments = {};
  for (let i = 0; i < ids.length; i++) {
    const workerId = ids[i];
    const chainIdx = (ids.indexOf(state.assignments[workerId]) + 1) % ids.length;
    newAssignments[workerId] = ids[chainIdx];
  }
  state.assignments = newAssignments;

  broadcast({ type: 'round_start', round: state.round });
  setTimeout(sendRoundPrompts, 1500);
}

function showResults() {
  stopTimer();
  state.phase = 'results';
  const results = Object.entries(state.chains).map(([ownerId, chain]) => ({
    owner: state.players[ownerId]?.name || '?',
    chain,
  }));
  broadcast({ type: 'results', results });
}

function resetGame() {
  stopTimer();
  state.phase = 'lobby';
  state.round = 0;
  state.chains = {};
  state.assignments = {};
  state.pending = new Set();
  for (const p of Object.values(state.players)) p.ready = false;
  broadcastLobby();
  log('🔄 Partie réinitialisée');
}

function kickPlayer(nameOrId) {
  const p = findPlayer(nameOrId);
  if (!p) return log(`❌ Joueur "${nameOrId}" introuvable`);
  send(p.ws, { type: 'kicked' });
  p.ws.close();
  log(`👢 ${p.name} a été kické`);
}

// ─── TROLL COMMANDS ───────────────────────────────────────────────────────────

function trollSend(typeRaw, fileRef, target) {
  const typeMap = {
    image: 'images', img: 'images', images: 'images',
    video: 'videos', vid: 'videos', videos: 'videos',
    sound: 'sounds', son: 'sounds', audio: 'sounds', sounds: 'sounds',
  };
  const cat = typeMap[typeRaw.toLowerCase()];
  if (!cat) return { error: `Type inconnu: "${typeRaw}"` };

  const dir = path.join(__dirname, 'public', 'trollmedia', cat);
  if (!fs.existsSync(dir)) return { error: `Dossier manquant: public/trollmedia/${cat}/` };

  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  if (files.length === 0) return { error: `Aucun fichier dans ${cat}/` };

  let filename;
  const idx = parseInt(fileRef);
  if (!isNaN(idx)) {
    if (idx < 0 || idx >= files.length) return { error: `Index ${idx} invalide` };
    filename = files[idx];
  } else {
    filename = files.find(f => f.toLowerCase() === fileRef.toLowerCase());
    if (!filename) return { error: `Fichier "${fileRef}" introuvable` };
  }

  const url = `/trollmedia/${cat}/${filename}`;
  const mediaType = typeRaw.startsWith('i') ? 'image' : typeRaw.startsWith('v') ? 'video' : 'sound';
  const payload = { type: 'troll', mediaType, url };

  if (target.toLowerCase() === 'all') {
    broadcast(payload);
  } else {
    const p = findPlayer(target);
    if (!p) return { error: `Joueur "${target}" introuvable` };
    send(p.ws, payload);
  }
  return { ok: true };
}

function trollEffect(mediaType, target) {
  const payload = { type: 'troll', mediaType };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
  } else {
    const p = findPlayer(target);
    if (!p) return { error: `Joueur "${target}" introuvable` };
    send(p.ws, payload);
  }
  return { ok: true };
}

function trollText(target, text) {
  const payload = { type: 'troll', mediaType: 'text', text };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
  } else {
    const p = findPlayer(target);
    if (!p) return { error: `Joueur "${target}" introuvable` };
    send(p.ws, payload);
  }
  return { ok: true };
}

// ─── ADMIN HTTP API ───────────────────────────────────────────────────────────

app.get('/api/admin/state', (req, res) => {
  res.json({
    phase: state.phase,
    round: state.round,
    totalRounds: state.totalRounds,
    timerDuration: state.timerDuration,
    timeLeft: state.timeLeft,
    players: playerList(),
  });
});

app.post('/api/admin/start', (req, res) => {
  startGame();
  res.json({ ok: true });
});

app.post('/api/admin/reset', (req, res) => {
  resetGame();
  res.json({ ok: true });
});

app.post('/api/admin/skip', (req, res) => {
  stopTimer(); advanceRound();
  res.json({ ok: true });
});

app.post('/api/admin/results', (req, res) => {
  showResults();
  res.json({ ok: true });
});

app.post('/api/admin/rounds', (req, res) => {
  const n = parseInt(req.body.value);
  if (n > 0) { state.totalRounds = n; res.json({ ok: true, totalRounds: n }); }
  else res.json({ error: 'Valeur invalide' });
});

app.post('/api/admin/timer', (req, res) => {
  const t = parseInt(req.body.value);
  if (t > 0) { state.timerDuration = t; res.json({ ok: true, timerDuration: t }); }
  else res.json({ error: 'Valeur invalide' });
});

app.post('/api/admin/kick', (req, res) => {
  const p = findPlayer(req.body.target);
  if (!p) return res.json({ error: `Joueur introuvable` });
  send(p.ws, { type: 'kicked' });
  p.ws.close();
  res.json({ ok: true });
});

app.post('/api/admin/chat', (req, res) => {
  const msg = req.body.text;
  broadcast({ type: 'chat', from: '🎮 ADMIN', text: msg });
  res.json({ ok: true });
});

app.post('/api/admin/trollshake', (req, res) => {
  res.json(trollEffect('shake', req.body.target || 'all'));
});

app.post('/api/admin/trollblind', (req, res) => {
  res.json(trollEffect('blind', req.body.target || 'all'));
});

app.post('/api/admin/trollzoom', (req, res) => {
  res.json(trollEffect('zoom', req.body.target || 'all'));
});

app.post('/api/admin/trollflip', (req, res) => {
  res.json(trollEffect('flip', req.body.target || 'all'));
});

app.post('/api/admin/trollclear', (req, res) => {
  res.json(trollEffect('clear', req.body.target || 'all'));
});

app.post('/api/admin/trolltext', (req, res) => {
  res.json(trollText(req.body.target || 'all', req.body.text));
});

app.post('/api/admin/trollsend', (req, res) => {
  res.json(trollSend(req.body.type, req.body.file, req.body.target || 'all'));
});

// ─── TROLL URL (image/vidéo/son par lien externe) ─────────────────────────────
app.post('/api/admin/trollurl', (req, res) => {
  const { url, mediaType, target } = req.body;
  if (!url || !mediaType) return res.json({ error: 'url et mediaType requis' });

  const validTypes = ['image', 'video', 'youtube', 'sound'];
  if (!validTypes.includes(mediaType)) return res.json({ error: `mediaType invalide: ${mediaType}` });

  const payload = { type: 'troll', mediaType, url };

  const t = (target || 'all').toLowerCase();
  if (t === 'all') {
    broadcast(payload);
  } else {
    const p = Object.values(state.players).find(
      p => p.name.toLowerCase() === t || p.id === t
    );
    if (!p) return res.json({ error: `Joueur "${target}" introuvable` });
    send(p.ws, payload);
  }
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const id = String(nextId++);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = (msg.name || 'Joueur').trim().slice(0, 20);
      state.players[id] = { id, ws, name, score: 0, ready: false };
      send(ws, { type: 'welcome', id, name, phase: state.phase, totalRounds: state.totalRounds });
      broadcastLobby();
      log(`✅ ${name} a rejoint (${Object.keys(state.players).length} joueurs)`);
    }

    else if (msg.type === 'ready') {
      if (state.players[id]) {
        state.players[id].ready = true;
        broadcastLobby();
        const allReady = Object.values(state.players).every(p => p.ready);
        if (allReady && Object.keys(state.players).length >= 2) {
          setTimeout(startGame, 1000);
        }
      }
    }

    else if (msg.type === 'submit') {
      if (state.phase === 'playing') {
        receiveSubmission(id, msg.content);
      }
    }
  });

  ws.on('close', () => {
    const p = state.players[id];
    if (p) {
      log(`👋 ${p.name} a quitté`);
      delete state.players[id];
      state.pending.delete(id);
      broadcastLobby();
      if (state.phase === 'playing' && state.pending.size === 0 && Object.keys(state.players).length > 0) {
        advanceRound();
      }
    }
  });
});

// ─── Admin CLI ────────────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (line) => {
  const [cmd, ...args] = line.trim().split(' ');
  switch (cmd) {
    case 'start':   startGame(); break;
    case 'reset':   resetGame(); break;
    case 'skip':    stopTimer(); advanceRound(); break;
    case 'results': showResults(); break;
    case 'rounds': { const n = parseInt(args[0]); if (n > 0) { state.totalRounds = n; log(`🔢 Rounds: ${n}`); } break; }
    case 'timer':  { const t = parseInt(args[0]); if (t > 0) { state.timerDuration = t; log(`⏱ Timer: ${t}s`); } break; }
    case 'kick':    kickPlayer(args.join(' ')); break;
    case 'chat':    broadcast({ type: 'chat', from: '🎮 ADMIN', text: args.join(' ') }); break;
    case 'trollshake':  trollEffect('shake', args[0] || 'all'); break;
    case 'trollblind':  trollEffect('blind', args[0] || 'all'); break;
    case 'trollzoom':   trollEffect('zoom', args[0] || 'all'); break;
    case 'trollflip':   trollEffect('flip', args[0] || 'all'); break;
    case 'trollclear':  trollEffect('clear', args[0] || 'all'); break;
    case 'trolltext':   trollText(args[0], args.slice(1).join(' ')); break;
    case 'trollsend':   trollSend(args[0], args[1], args.slice(2).join(' ') || 'all'); break;
    default: log(`Commande inconnue: "${cmd}"`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨 GARTICPHONE SERVER on port ${PORT}`);
  console.log(`🔧 Admin panel: http://localhost:${PORT}/admin.html`);
});
