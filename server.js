const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const readline = require('readline');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

function listTrollMedia() {
  const base = path.join(__dirname, 'public', 'trollmedia');
  log('\n📁 Médias disponibles dans public/trollmedia/ :');
  for (const cat of ['images', 'videos', 'sounds']) {
    const dir = path.join(base, cat);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    if (files.length === 0) {
      log(`  ${cat}/ → (vide)`);
    } else {
      log(`  ${cat}/`);
      files.forEach((f, i) => log(`    [${i}] ${f}`));
    }
  }
  log('');
}

/**
 * trollsend <type> <index_ou_nom> <joueur|all>
 * ex: trollsend image 0 Jean
 * ex: trollsend video rick.mp4 all
 * ex: trollsend sound 1 all
 */
function trollSend(args) {
  if (args.length < 3) {
    return log('Usage : trollsend <image|video|sound> <index|nom_fichier> <joueur|all>');
  }
  const [typeRaw, fileRef, ...nameParts] = args;
  const target = nameParts.join(' ');

  const typeMap = {
    image: 'images', img: 'images', images: 'images',
    video: 'videos', vid: 'videos', videos: 'videos',
    sound: 'sounds', son: 'sounds', audio: 'sounds', sounds: 'sounds',
  };
  const cat = typeMap[typeRaw.toLowerCase()];
  if (!cat) return log(`❌ Type inconnu: "${typeRaw}" (utilise image, video ou sound)`);

  const dir = path.join(__dirname, 'public', 'trollmedia', cat);
  if (!fs.existsSync(dir)) return log(`❌ Dossier manquant: public/trollmedia/${cat}/`);

  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  if (files.length === 0) return log(`❌ Aucun fichier dans public/trollmedia/${cat}/`);

  let filename;
  const idx = parseInt(fileRef);
  if (!isNaN(idx)) {
    if (idx < 0 || idx >= files.length) return log(`❌ Index ${idx} invalide (0-${files.length - 1})`);
    filename = files[idx];
  } else {
    filename = files.find(f => f.toLowerCase() === fileRef.toLowerCase());
    if (!filename) return log(`❌ Fichier "${fileRef}" introuvable dans ${cat}/`);
  }

  const url = `/trollmedia/${cat}/${filename}`;
  const payload = { type: 'troll', mediaType: typeRaw.startsWith('i') ? 'image' : typeRaw.startsWith('v') ? 'video' : 'sound', url };

  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log(`🎭 Troll envoyé à TOUS : ${filename}`);
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`🎭 Troll envoyé à ${p.name} : ${filename}`);
  }
}

/**
 * trolltext <joueur|all> <message>
 * Affiche un gros texte sur l'écran du joueur
 */
function trollText(args) {
  if (args.length < 2) return log('Usage : trolltext <joueur|all> <message>');
  const [target, ...msgParts] = args;
  const text = msgParts.join(' ');
  const payload = { type: 'troll', mediaType: 'text', text };

  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log(`💬 Troll texte → TOUS : "${text}"`);
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`💬 Troll texte → ${p.name} : "${text}"`);
  }
}

/**
 * trollshake <joueur|all>  — fait trembler l'écran
 */
function trollShake(args) {
  const target = args.join(' ') || 'all';
  const payload = { type: 'troll', mediaType: 'shake' };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log('📳 Shake envoyé à TOUS');
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`📳 Shake envoyé à ${p.name}`);
  }
}

/**
 * trollblind <joueur|all>  — écran noir pendant 3s
 */
function trollBlind(args) {
  const target = args.join(' ') || 'all';
  const payload = { type: 'troll', mediaType: 'blind' };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log('🕶️  Blind envoyé à TOUS');
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`🕶️  Blind envoyé à ${p.name}`);
  }
}

/**
 * trollzoom <joueur|all>  — zoom in/out brutal
 */
function trollZoom(args) {
  const target = args.join(' ') || 'all';
  const payload = { type: 'troll', mediaType: 'zoom' };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log('🔍 Zoom envoyé à TOUS');
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`🔍 Zoom envoyé à ${p.name}`);
  }
}

/**
 * trollflip <joueur|all>  — retourne l'écran à l'envers
 */
function trollFlip(args) {
  const target = args.join(' ') || 'all';
  const payload = { type: 'troll', mediaType: 'flip' };
  if (target.toLowerCase() === 'all') {
    broadcast(payload);
    log('🙃 Flip envoyé à TOUS');
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`🙃 Flip envoyé à ${p.name}`);
  }
}

/**
 * Annule le troll actif sur un joueur (ou tous)
 */
function trollClear(args) {
  const target = args.join(' ') || 'all';
  const payload = { type: 'troll', mediaType: 'clear' };
  if (target.toLowerCase() === 'all' || !target) {
    broadcast(payload);
    log('✨ Troll effacé pour TOUS');
  } else {
    const p = findPlayer(target);
    if (!p) return log(`❌ Joueur "${target}" introuvable`);
    send(p.ws, payload);
    log(`✨ Troll effacé pour ${p.name}`);
  }
}

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

function showHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              GARTICPHONE — COMMANDES ADMIN                   ║
╠══════════════════════════════════════════════════════════════╣
║  PARTIE                                                      ║
║  start             → Démarrer la partie                      ║
║  reset             → Réinitialiser                           ║
║  skip              → Passer le round actuel                  ║
║  results           → Afficher les résultats maintenant       ║
║  rounds <n>        → Changer le nb de rounds (ex: rounds 5) ║
║  timer <sec>       → Changer le timer (ex: timer 60)         ║
║                                                              ║
║  JOUEURS                                                     ║
║  players           → Liste des joueurs connectés             ║
║  kick <nom>        → Expulser un joueur                      ║
║  chat <msg>        → Envoyer un message à tous               ║
║                                                              ║
║  TROLL 😈                                                    ║
║  media             → Lister les fichiers troll dispo         ║
║  trollsend <image|video|sound> <index|nom> <joueur|all>      ║
║    ex: trollsend image 0 Jean                                ║
║    ex: trollsend video rick.mp4 all                          ║
║  trolltext <joueur|all> <message>                            ║
║    ex: trolltext Jean T'as perdu !                           ║
║  trollshake [joueur|all]  → Faire trembler l'écran           ║
║  trollblind [joueur|all]  → Écran noir 3 secondes            ║
║  trollzoom  [joueur|all]  → Zoom brutal                      ║
║  trollflip  [joueur|all]  → Écran à l'envers 5s              ║
║  trollclear [joueur|all]  → Annuler le troll actif           ║
║                                                              ║
║  help              → Cette aide                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

rl.on('line', (line) => {
  const [cmd, ...args] = line.trim().split(' ');
  switch (cmd) {
    case 'start':   startGame(); break;
    case 'reset':   resetGame(); break;
    case 'skip':    stopTimer(); advanceRound(); break;
    case 'results': showResults(); break;

    case 'rounds': {
      const n = parseInt(args[0]);
      if (n > 0) { state.totalRounds = n; log(`🔢 Rounds par joueur: ${n}`); }
      break;
    }
    case 'timer': {
      const t = parseInt(args[0]);
      if (t > 0) { state.timerDuration = t; log(`⏱  Timer: ${t}s`); }
      break;
    }

    case 'players': {
      const ps = Object.values(state.players);
      if (ps.length === 0) { log('Aucun joueur connecté'); break; }
      ps.forEach(p => log(`  • [${p.id}] ${p.name} ready:${p.ready}`));
      break;
    }
    case 'kick':    kickPlayer(args.join(' ')); break;
    case 'chat': {
      const msg = args.join(' ');
      broadcast({ type: 'chat', from: '🎮 ADMIN', text: msg });
      log(`💬 Message envoyé: "${msg}"`);
      break;
    }

    // Troll
    case 'media':       listTrollMedia(); break;
    case 'trollsend':   trollSend(args); break;
    case 'trolltext':   trollText(args); break;
    case 'trollshake':  trollShake(args); break;
    case 'trollblind':  trollBlind(args); break;
    case 'trollzoom':   trollZoom(args); break;
    case 'trollflip':   trollFlip(args); break;
    case 'trollclear':  trollClear(args); break;

    case 'help':
    case '':    showHelp(); break;
    default:    log(`Commande inconnue: "${cmd}" — tape "help" pour l'aide`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨 GARTICPHONE SERVER`);
  console.log(`═══════════════════════════════════════`);
  console.log(`🌐 Tes potes se connectent sur :`);
  console.log(`   http://TON_IP_LOCAL:${PORT}`);
  console.log(`   (trouve ton IP avec: ipconfig / ip a)`);
  console.log(`═══════════════════════════════════════`);
  console.log(`📁 Mets tes fichiers troll dans :`);
  console.log(`   public/trollmedia/images/`);
  console.log(`   public/trollmedia/videos/`);
  console.log(`   public/trollmedia/sounds/`);
  console.log(`═══════════════════════════════════════`);
  showHelp();
});
