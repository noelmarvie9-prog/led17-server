require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

const server = http.createServer(app);

// ══════════════════════════════════════
//  WEBSOCKET — temps réel pour le site
// ══════════════════════════════════════
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ══════════════════════════════════════
//  MONGODB — Modèles
// ══════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI);

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, lowercase: true },
  password: String,
  points: { type: Number, default: 0 },
  totalWagered: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  dliveUsername: { type: String, default: null, lowercase: true },
  linkCode: { type: String, unique: true, sparse: true },
  lastSpin: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'users' });
// Force default points to 0 on every new user
UserSchema.pre('save', function(next) {
  if (this.isNew && this.points === undefined) this.points = 0;
  next();
});
const User = mongoose.model('User', UserSchema);

const SlotCallSchema = new mongoose.Schema({
  dliveUsername: String,
  siteUsername: String,
  slotName: String,
  createdAt: { type: Date, default: Date.now }
});
const SlotCall = mongoose.model('SlotCall', SlotCallSchema);

const RaffleSchema = new mongoose.Schema({
  prize: Number,
  participants: [String],
  winner: String,
  status: { type: String, enum: ['active', 'finished'], default: 'active' },
  endsAt: Date,
  createdAt: { type: Date, default: Date.now }
});
const Raffle = mongoose.model('Raffle', RaffleSchema);

// ══════════════════════════════════════
//  AUTH MIDDLEWARE
// ══════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin requis' });
  next();
}

// ══════════════════════════════════════
//  ROUTES AUTH
// ══════════════════════════════════════
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
    const hashed = await bcrypt.hash(password, 10);
    // Generate unique 6-char link code
    const linkCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const user = new User({ username: username.toLowerCase(), password: hashed, linkCode, points: 0 });
    await user.save();
    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, process.env.JWT_SECRET);
    res.json({ token, username: user.username, points: user.points, isAdmin: user.isAdmin, linkCode: user.linkCode, dliveUsername: user.dliveUsername });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Pseudo déjà pris' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(400).json({ error: 'Utilisateur introuvable' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Mot de passe incorrect' });
    // Generate linkCode if missing
    if (!user.linkCode) {
      user.linkCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await user.save();
    }
    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, process.env.JWT_SECRET);
    res.json({ token, username: user.username, points: user.points, isAdmin: user.isAdmin, linkCode: user.linkCode, dliveUsername: user.dliveUsername });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════
//  ROUTES UTILISATEUR
// ══════════════════════════════════════
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  res.json(user);
});

app.get('/api/leaderboard', async (req, res) => {
  const users = await User.find({ totalWagered: { $gt: 0 } }).sort({ totalWagered: -1 }).limit(20).select('username points totalWagered');
  res.json(users);
});

// Track wager when points are updated
app.post('/api/points/update', authMiddleware, async (req, res) => {
  const { delta } = req.body;
  const user = await User.findById(req.user.id);
  user.points = Math.max(0, user.points + delta);
  // Track wagers (negative delta = mise)
  if (delta < 0) user.totalWagered = (user.totalWagered || 0) + Math.abs(delta);
  await user.save();
  broadcast({ type: 'points_update', username: user.username, points: user.points });
  res.json({ points: user.points });
});

// ══════════════════════════════════════
//  ROUTE ROUE — 24h cooldown
// ══════════════════════════════════════
app.post('/api/wheel/spin', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const now = new Date();
    if (user.lastSpin) {
      const diff = now - new Date(user.lastSpin);
      const hours24 = 24 * 60 * 60 * 1000;
      if (diff < hours24) {
        const remaining = hours24 - diff;
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        return res.status(400).json({ error: `Reviens dans ${h}h ${m}min !` });
      }
    }
    const { prize } = req.body;
    user.points = Math.max(0, user.points + (prize || 0));
    user.lastSpin = now;
    await user.save();
    broadcast({ type: 'points_update', username: user.username, points: user.points });
    res.json({ points: user.points, lastSpin: user.lastSpin });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════
//  ROUTE LIAISON DLIVE
// ══════════════════════════════════════
app.post('/api/dlive/link', authMiddleware, async (req, res) => {
  try {
    const { dliveUsername } = req.body;
    if (!dliveUsername || dliveUsername.trim().length < 2) {
      return res.status(400).json({ error: 'Pseudo DLive invalide' });
    }
    const user = await User.findById(req.user.id);
    // Check if this DLive username is already linked to another account
    const existing = await User.findOne({ dliveUsername: dliveUsername.toLowerCase(), _id: { $ne: user._id } });
    if (existing) {
      return res.status(400).json({ error: 'Ce pseudo DLive est déjà lié à un autre compte' });
    }
    user.dliveUsername = dliveUsername.toLowerCase().trim();
    await user.save();
    broadcast({ type: 'dlive_linked', username: user.username, dliveUsername: user.dliveUsername });
    res.json({ success: true, dliveUsername: user.dliveUsername });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/wheel/status', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id);
  const now = new Date();
  if (!user.lastSpin) return res.json({ canSpin: true, nextSpin: null });
  const diff = now - new Date(user.lastSpin);
  const hours24 = 24 * 60 * 60 * 1000;
  if (diff >= hours24) return res.json({ canSpin: true, nextSpin: null });
  const nextSpin = new Date(new Date(user.lastSpin).getTime() + hours24);
  res.json({ canSpin: false, nextSpin });
});

// ══════════════════════════════════════
//  ROUTES SLOT CALLS
// ══════════════════════════════════════
app.get('/api/slotcalls', authMiddleware, adminMiddleware, async (req, res) => {
  const calls = await SlotCall.find().sort({ createdAt: -1 }).limit(50);
  res.json(calls);
});

app.delete('/api/slotcalls/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await SlotCall.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════
//  ROUTES RAFFLE
// ══════════════════════════════════════
app.get('/api/raffle/active', async (req, res) => {
  const raffle = await Raffle.findOne({ status: 'active' });
  res.json(raffle || null);
});

// Admin lance une raffle
app.post('/api/raffle/start', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { prize, duration = 120 } = req.body; // duration en secondes, défaut 2min
    if (!prize || prize < 1) return res.status(400).json({ error: 'Mise invalide' });

    // Fermer toute raffle active
    await Raffle.updateMany({ status: 'active' }, { status: 'finished' });

    const endsAt = new Date(Date.now() + duration * 1000);
    const raffle = new Raffle({ prize, endsAt });
    await raffle.save();

    broadcast({ type: 'raffle_start', prize, endsAt, id: raffle._id });

    // Timer automatique pour clore la raffle
    setTimeout(() => finishRaffle(raffle._id), duration * 1000);

    res.json({ success: true, raffle });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rejoindre une raffle
app.post('/api/raffle/join', authMiddleware, async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ status: 'active' });
    if (!raffle) return res.status(400).json({ error: 'Pas de raffle active' });
    if (raffle.endsAt < new Date()) return res.status(400).json({ error: 'Raffle terminée' });
    if (raffle.participants.includes(req.user.username)) {
      return res.status(400).json({ error: 'Déjà inscrit' });
    }
    raffle.participants.push(req.user.username);
    await raffle.save();
    broadcast({ type: 'raffle_join', username: req.user.username, count: raffle.participants.length });
    res.json({ success: true, participants: raffle.participants.length });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Tirer le gagnant
async function finishRaffle(raffleId) {
  const raffle = await Raffle.findById(raffleId);
  if (!raffle || raffle.status === 'finished') return;

  raffle.status = 'finished';

  if (raffle.participants.length === 0) {
    await raffle.save();
    broadcast({ type: 'raffle_end', winners: [], prize: raffle.prize, each: 0, message: 'Personne n\'a participé !' });
    return;
  }

  const count = raffle.participants.length;
  const each = Math.floor(raffle.prize / count);
  raffle.winner = raffle.participants.join(', ');
  await raffle.save();

  // Créditer les points à TOUS les participants
  for (const username of raffle.participants) {
    await User.findOneAndUpdate(
      { username: username.toLowerCase() },
      { $inc: { points: each } }
    );
  }

  broadcast({
    type: 'raffle_end',
    winners: raffle.participants,
    prize: raffle.prize,
    each,
    message: `🎉 ${count} gagnant(s) — chacun reçoit ${each} pts !`
  });
  console.log(`[RAFFLE] ${count} gagnant(s) — +${each} pts chacun`);
  await sendChatMessage(`🎉 Raffle terminée ! ${count} gagnant(s) — chacun reçoit ${each} pts sur le site !`);
}

// Endpoint admin pour forcer la fin
app.post('/api/raffle/finish', authMiddleware, adminMiddleware, async (req, res) => {
  const raffle = await Raffle.findOne({ status: 'active' });
  if (!raffle) return res.status(400).json({ error: 'Pas de raffle active' });
  await finishRaffle(raffle._id);
  res.json({ success: true });
});

// ══════════════════════════════════════
//  BOT DLIVE — Écoute le chat
// ══════════════════════════════════════
const DLIVE_WS = 'wss://graphigostream.prd.dlive.tv';
const DLIVE_API = 'https://graphigo.prd.dlive.tv/';
const ADMIN_USERS = (process.env.ADMIN_USERS || '').toLowerCase().split(',').map(s => s.trim());

async function sendChatMessage(message) {
  const token = process.env.DLIVE_BOT_TOKEN;
  const streamer = process.env.DLIVE_USERNAME;
  if (!token || !streamer) return;
  try {
    await fetch(DLIVE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({
        query: `mutation SendStreamChatMessage($input: SendStreamChatMessageInput!) {
          sendStreamChatMessage(input: $input) { err { code message } }
        }`,
        variables: {
          input: {
            streamer: streamer.toLowerCase(),
            message,
            roomRole: 'Member',
            subscribing: false
          }
        }
      })
    });
    console.log(`[BOT] Message envoyé : ${message}`);
  } catch(e) {
    console.error('[BOT] Erreur envoi message:', e.message);
  }
}

const DLIVE_SUBSCRIPTION = (username) => JSON.stringify({
  type: 'start',
  id: '1',
  payload: {
    query: `subscription {
      streamMessageReceived(streamer: "${username.toLowerCase()}") {
        type
        ... on ChatText { content sender { displayname username } }
        ... on ChatGift { gift sender { displayname username } }
        ... on ChatFollow { sender { displayname username } }
      }
    }`
  }
});

function startDLiveBot() {
  const username = process.env.DLIVE_USERNAME;
  if (!username) { console.log('[BOT] DLIVE_USERNAME non défini, bot désactivé'); return; }

  console.log(`[BOT] Connexion au chat DLive de ${username}...`);

  const ws = new WebSocket(DLIVE_WS, ['graphql-ws']);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    setTimeout(() => {
      ws.send(DLIVE_SUBSCRIPTION(username));
      console.log('[BOT] Subscription envoyée ✅');
    }, 1000);
    console.log('[BOT] Connecté au chat DLive ✅');
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      console.log('[BOT] Message reçu:', msg.type, JSON.stringify(msg).substring(0, 100));
      if (msg.type === 'connection_ack') {
        console.log('[BOT] Connection ACK reçu ✅');
        return;
      }
      if (msg.type !== 'data') return;

      const event = msg.payload?.data?.streamMessageReceived;
      if (!event) return;

      // Handle array or single object
      const events = Array.isArray(event) ? event : [event];
      for (const ev of events) {
        if (!ev || ev.type !== 'Message') continue;
        const content = ev.content?.trim().toLowerCase();
        const sender = ev.sender?.username?.toLowerCase();
        const displayName = ev.sender?.displayname || sender;
        console.log(`[BOT] Chat — ${displayName}: ${ev.content}`);

      // Commande !call nomslot
      const callMatch = content.match(/^!call\s+(.+)$/i);
      if (callMatch) {
        const slotName = callMatch[1].trim();
        const user = await User.findOne({ dliveUsername: sender });
        const siteUsername = user ? user.username : null;
        const call = new SlotCall({ dliveUsername: sender, siteUsername, slotName });
        await call.save();
        broadcast({ type: 'slot_call', dliveUsername: sender, siteUsername, slotName, id: call._id });
        console.log(`[BOT] !call ${slotName} par ${sender}`);
        return;
      }

      // Commande !link CODE — lier compte DLive au compte site
      const linkMatch = content.match(/^!link\s+([a-z0-9]+)$/i);
      if (linkMatch) {
        const code = linkMatch[1].toUpperCase();
        const user = await User.findOne({ linkCode: code });
        if (!user) {
          console.log(`[BOT] !link ${code} — code introuvable`);
          return;
        }
        if (user.dliveUsername && user.dliveUsername !== sender) {
          console.log(`[BOT] !link — compte déjà lié à ${user.dliveUsername}`);
          return;
        }
        user.dliveUsername = sender;
        await user.save();
        broadcast({ type: 'dlive_linked', username: user.username, dliveUsername: sender });
        console.log(`[BOT] ${sender} lié au compte site ${user.username} ✅`);
        await sendChatMessage(`✅ ${displayName} ton compte DLive est bien lié au site LeD17 ! Tu peux maintenant participer aux raffles avec !join.`);
        return;
      }

      // Commande !raffle<montant> — admin seulement
      // Commande !raffle ou !raffle <montant> — admin seulement
      const raffleMatch = content.match(/^!raffle\s*(\d*)$/);
      if (raffleMatch && ADMIN_USERS.includes(sender)) {
        const prize = parseInt(raffleMatch[1]) || 1000; // défaut 1000 si pas de montant
        const duration = 60; // 1 minute
        await Raffle.updateMany({ status: 'active' }, { status: 'finished' });
        const endsAt = new Date(Date.now() + duration * 1000);
        const raffle = new Raffle({ prize, endsAt });
        await raffle.save();
        broadcast({ type: 'raffle_start', prize, endsAt, id: raffle._id });
        setTimeout(() => finishRaffle(raffle._id), duration * 1000);
        console.log(`[BOT] Raffle lancée par ${sender} — ${prize} pts`);
        await sendChatMessage(`🎰 RAFFLE LANCÉE ! ${prize} pts à distribuer ! Tapez !join pour participer — vous avez ${duration} secondes !`);
        continue;
      }

      // Commande !join — rejoindre la raffle via pseudo DLive
      if (content === '!join') {
        const raffle = await Raffle.findOne({ status: 'active' });
        if (!raffle || raffle.endsAt < new Date()) continue;
        // Chercher le compte site lié à ce pseudo DLive
        const user = await User.findOne({ dliveUsername: sender });
        if (!user) {
          console.log(`[BOT] !join — ${sender} n'a pas lié son compte (utilise !link CODE)`);
          continue;
        }
        if (raffle.participants.includes(user.username)) continue;
        raffle.participants.push(user.username);
        await raffle.save();
        broadcast({ type: 'raffle_join', username: user.username, count: raffle.participants.length });
        console.log(`[BOT] ${sender} (→ ${user.username}) a rejoint la raffle`);
        continue;
      }
      } // end for loop

    } catch (e) {
      console.error('[BOT] Erreur:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[BOT] Déconnecté — reconnexion dans 5s...');
    setTimeout(startDLiveBot, 5000);
  });

  ws.on('error', (e) => console.error('[BOT] Erreur WS:', e.message));
}

// ══════════════════════════════════════
//  DÉMARRAGE
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
mongoose.connection.once('open', () => {
  console.log('[DB] MongoDB connecté ✅');
  server.listen(PORT, () => {
    console.log(`[SERVER] Serveur démarré sur le port ${PORT} ✅`);
    startDLiveBot();
  });
});
