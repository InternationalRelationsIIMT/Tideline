'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const Engine = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST_PIN = process.env.HOST_PIN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

// =========================================================================
// LAN IP DISCOVERY
// =========================================================================
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const isV4 = net.family === 'IPv4' || net.family === 4;
      if (isV4 && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// =========================================================================
// PERSISTENT HALL OF FAME (leaderboard.json, top 20)
// =========================================================================
function readLeaderboard() {
  try {
    if (!fs.existsSync(LEADERBOARD_FILE)) return [];
    const raw = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeLeaderboard(entries) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries.slice(0, 20), null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write leaderboard.json:', e.message);
  }
}

function recordMatchToLeaderboard(matchState) {
  if (!matchState || !matchState.players) return;
  const current = readLeaderboard();
  const dateStr = new Date().toISOString().slice(0, 10);
  const playerCount = matchState.players.length;
  matchState.players.forEach(pl => {
    if (pl.isBot) return;
    const score = pl.cash - Engine.GAME_CONFIG.STARTING_CASH;
    current.push({
      name: pl.name,
      score: score,
      rankTitle: Engine.getRankTitle(score),
      date: dateStr,
      playerCount: playerCount
    });
  });
  current.sort((a, b) => b.score - a.score);
  writeLeaderboard(current.slice(0, 20));
}

// =========================================================================
// HTTP SERVER (Serves /public, /board, and Hall of Fame API)
// =========================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && pathname === '/api/info') {
    const lanIp = getLanIp();
    return sendJson(res, 200, {
      lanUrl: `http://${lanIp}:${PORT}`,
      port: PORT,
      pinProtected: HOST_PIN.length > 0
    });
  }

  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    return sendJson(res, 200, { entries: readLeaderboard() });
  }

  if (req.method === 'POST' && pathname === '/api/leaderboard/reset') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (HOST_PIN && String(parsed.pin || '') !== HOST_PIN) {
          return sendJson(res, 403, { error: 'Invalid host PIN.' });
        }
        writeLeaderboard([]);
        broadcastAll({ type: 'leaderboard_updated', entries: [] });
        return sendJson(res, 200, { ok: true, entries: [] });
      } catch (e) {
        return sendJson(res, 400, { error: 'Bad request' });
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }

  let relPath = pathname === '/' || pathname === '/board' ? '/index.html' : pathname;
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

// =========================================================================
// MULTIPLAYER ROOMS & AUTHORITATIVE STATE
// =========================================================================
const rooms = new Map(); // code -> room object
const PLAYER_COLORS = ['#13A89E', '#E4572E', '#C9A227', '#2563EB', '#8B5CF6', '#EC4899', '#16A34A', '#F97316'];
const BOT_NAMES = ['Capt. Vance', 'Capt. Lin', 'Capt. Moreau', 'Capt. Nair', 'Capt. Thorne', 'Capt. Volkov', 'Capt. Silva'];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
  return 'SHIP';
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function sanitizeName(raw) {
  const s = String(raw || '').replace(/[^\w\s.\-']/g, '').trim().slice(0, 18);
  return s || 'Captain';
}

function createRoom(hostName, hostColor) {
  const code = makeRoomCode();
  const hostId = 'p_' + crypto.randomBytes(4).toString('hex');
  const hostToken = makeToken();
  const color = PLAYER_COLORS.includes(hostColor) ? hostColor : PLAYER_COLORS[0];

  const room = {
    code,
    hostId,
    phase: 'lobby', // lobby | planning | reveal | report | finished
    earlyResolveOnAllLocked: true,
    paused: false,
    pausedRemainingMs: 0,
    endsAt: 0,
    revealEndsAt: 0,
    timerHandle: null,
    hostGraceTimer: null,
    matchState: null,
    lastRoundSummary: null,
    leaderboardRecorded: false,
    sockets: new Map(), // playerId -> ws
    boards: new Set(),  // spectator /board ws
    players: [
      {
        id: hostId,
        token: hostToken,
        name: sanitizeName(hostName),
        color,
        isBot: false,
        botStyle: null,
        connected: true,
        lockedIn: false,
        touchedThisRound: false,
        draftPlan: Engine.createEmptyPlan()
      }
    ]
  };
  rooms.set(code, room);
  return { room, hostId, hostToken };
}

function serializeRoomForClient(room, viewerId) {
  const ms = room.matchState;
  const playersView = room.players.map(rp => {
    const mp = ms ? ms.players.find(x => x.id === rp.id) : null;
    return {
      id: rp.id,
      name: rp.name,
      color: rp.color,
      isBot: rp.isBot,
      botStyle: rp.botStyle,
      isHost: rp.id === room.hostId,
      connected: rp.isBot ? true : rp.connected,
      lockedIn: rp.lockedIn,
      cash: mp ? mp.cash : Engine.GAME_CONFIG.STARTING_CASH,
      prevCash: mp ? mp.prevCash : Engine.GAME_CONFIG.STARTING_CASH,
      rank: mp ? mp.rank : 1,
      prevRank: mp ? mp.prevRank : 1,
      worstRoundLoss: mp ? mp.worstRoundLoss : 0,
      roundProfits: mp ? mp.roundProfits : [],
      reputation: mp && rp.id === viewerId ? mp.reputation : undefined
    };
  });

  // Never leak other players' plans during planning!
  const me = viewerId ? room.players.find(p => p.id === viewerId) : null;

  return {
    type: 'room_state',
    serverTime: Date.now(),
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    viewerId: viewerId || null,
    earlyResolveOnAllLocked: room.earlyResolveOnAllLocked,
    paused: room.paused,
    pausedRemainingMs: room.pausedRemainingMs,
    endsAt: room.endsAt,
    revealEndsAt: room.revealEndsAt,
    players: playersView,
    myPlan: me ? me.draftPlan : null,
    match: ms ? {
      round: ms.round,
      fleetSize: Engine.GAME_CONFIG.FLEET_SCHEDULE[ms.round - 1],
      countryUnlockOrder: ms.countryUnlockOrder,
      priceIndex: ms.priceIndex,
      priceHistory: ms.priceHistory,
      demandDrift: ms.demandDrift,
      briefing: ms.briefing,
      finished: !!ms.finished
    } : null,
    lastRoundSummary: (room.phase === 'reveal' || room.phase === 'report' || room.phase === 'finished')
      ? room.lastRoundSummary
      : null
  };
}

function broadcastRoom(room) {
  room.players.forEach(rp => {
    const ws = room.sockets.get(rp.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(serializeRoomForClient(room, rp.id)));
    }
  });
  room.boards.forEach(bws => {
    if (bws.readyState === WebSocket.OPEN) {
      bws.send(JSON.stringify(serializeRoomForClient(room, null)));
    }
  });
}

function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function clearRoomTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
}

function startPlanningRound(room) {
  clearRoomTimer(room);
  const ms = room.matchState;
  room.phase = 'planning';
  room.paused = false;
  room.pausedRemainingMs = 0;
  room.endsAt = Date.now() + Engine.GAME_CONFIG.ROUND_DURATION_SEC * 1000;

  const unlockedCountries = (ms.briefing && ms.briefing.unlockedCountries) || Engine.getUnlockedCountryIds(ms.countryUnlockOrder, ms.round);
  room.players.forEach(rp => {
    rp.lockedIn = rp.isBot; // bots are always ready
    rp.touchedThisRound = false;
    rp.draftPlan = Engine.createEmptyPlan();
  });

  room.timerHandle = setTimeout(() => {
    resolveActivePlanningRound(room);
  }, Engine.GAME_CONFIG.ROUND_DURATION_SEC * 1000);

  broadcastRoom(room);
}

function resolveActivePlanningRound(room) {
  if (room.phase !== 'planning') return;
  clearRoomTimer(room);

  const ms = room.matchState;
  const plansByPlayerId = {};

  const unlockedCountries = (ms.briefing && ms.briefing.unlockedCountries) || Engine.getUnlockedCountryIds(ms.countryUnlockOrder, ms.round);
  room.players.forEach(rp => {
    const mp = ms.players.find(x => x.id === rp.id);
    if (rp.isBot) {
      const botRng = Engine.mulberry32((ms.seed ^ (ms.round * 7919) ^ rp.id.charCodeAt(2)) >>> 0);
      plansByPlayerId[rp.id] = Engine.buildStrategyPlan(rp.botStyle || 'Adaptive', ms, mp, botRng);
    } else if (rp.lockedIn) {
      plansByPlayerId[rp.id] = Engine.validateAndNormalizePlan(rp.draftPlan, ms.briefing.closedTags, unlockedCountries);
    } else if (rp.touchedThisRound) {
      plansByPlayerId[rp.id] = Engine.validateAndNormalizePlan(rp.draftPlan, ms.briefing.closedTags, unlockedCountries);
    } else {
      // Untouched at 0:00 -> reuse previous round's plan (or default on R1)
      const prev = (mp && mp.lastPlan) ? mp.lastPlan : Engine.createDefaultPlan(ms.briefing.closedTags, unlockedCountries);
      plansByPlayerId[rp.id] = Engine.validateAndNormalizePlan(prev, ms.briefing.closedTags, unlockedCountries);
    }
  });

  const summary = Engine.resolveRound(ms, plansByPlayerId);
  room.lastRoundSummary = summary;
  room.phase = 'reveal';
  room.revealEndsAt = Date.now() + Engine.GAME_CONFIG.REVEAL_DURATION_SEC * 1000;

  if (ms.finished && !room.leaderboardRecorded) {
    room.leaderboardRecorded = true;
    recordMatchToLeaderboard(ms);
    broadcastAll({ type: 'leaderboard_updated', entries: readLeaderboard() });
  }

  room.timerHandle = setTimeout(() => {
    finishRevealPhase(room);
  }, Engine.GAME_CONFIG.REVEAL_DURATION_SEC * 1000);

  broadcastRoom(room);
}

function finishRevealPhase(room) {
  if (room.phase !== 'reveal') return;
  clearRoomTimer(room);
  room.phase = 'report';
  broadcastRoom(room);
}

function sanitizePartialDraftPlan(rawPlan, closedTags, unlockedCountries) {
  if (!rawPlan || typeof rawPlan !== 'object') return null;
  if (!rawPlan.countryPct || !rawPlan.commodityPct || !rawPlan.routeStance) return null;
  const cKeys = Engine.COUNTRIES.map(c => c.id);
  const mKeys = Engine.COMMODITIES.map(c => c.id);
  const out = Engine.createEmptyPlan();

  let cSum = 0;
  for (const k of cKeys) {
    const v = Math.round(Number(rawPlan.countryPct[k]) || 0);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    if (unlockedCountries && unlockedCountries.length && v > 0 && !unlockedCountries.includes(k)) {
      out.countryPct[k] = 0;
    } else {
      out.countryPct[k] = v;
      cSum += v;
    }
  }
  if (cSum > 101) return null;

  let mSum = 0;
  for (const k of mKeys) {
    const v = Math.round(Number(rawPlan.commodityPct[k]) || 0);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    out.commodityPct[k] = v;
    mSum += v;
  }
  if (mSum > 101) return null;

  for (const k of cKeys) {
    const rawSt = rawPlan.routeStance[k];
    if (rawSt === null || rawSt === undefined || rawSt === '') {
      out.routeStance[k] = null;
    } else {
      const st = Number(rawSt);
      const opts = Engine.ROUTES_BY_COUNTRY[k];
      if (Number.isInteger(st) && st >= 0 && st < opts.length && !Engine.isRouteClosed(opts[st], closedTags)) {
        out.routeStance[k] = st;
      } else {
        out.routeStance[k] = null;
      }
    }
  }
  return out;
}

function validateClientPlan(rawPlan, closedTags, unlockedCountries) {
  if (!rawPlan || typeof rawPlan !== 'object') return null;
  const cKeys = Engine.COUNTRIES.map(c => c.id);
  const mKeys = Engine.COMMODITIES.map(c => c.id);

  if (!rawPlan.countryPct || !rawPlan.commodityPct || !rawPlan.routeStance) return null;

  let cSum = 0;
  for (const k of cKeys) {
    const v = Number(rawPlan.countryPct[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    if (unlockedCountries && unlockedCountries.length && v > 0.5 && !unlockedCountries.includes(k)) {
      return null;
    }
    cSum += v;
  }
  if (Math.abs(cSum - 100) > 1.5) return null;

  let mSum = 0;
  for (const k of mKeys) {
    const v = Number(rawPlan.commodityPct[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    mSum += v;
  }
  if (Math.abs(mSum - 100) > 1.5) return null;

  for (const k of cKeys) {
    const pct = Number(rawPlan.countryPct[k]) || 0;
    const rawSt = rawPlan.routeStance[k];
    if (pct > 0.5) {
      if (rawSt === null || rawSt === undefined || rawSt === '') return null;
      const st = Number(rawSt);
      const opts = Engine.ROUTES_BY_COUNTRY[k];
      if (!Number.isInteger(st) || st < 0 || st >= opts.length) return null;
      if (Engine.isRouteClosed(opts[st], closedTags)) return null;
    } else if (rawSt !== null && rawSt !== undefined && rawSt !== '') {
      const st = Number(rawSt);
      const opts = Engine.ROUTES_BY_COUNTRY[k];
      if (!Number.isInteger(st) || st < 0 || st >= opts.length) return null;
      if (Engine.isRouteClosed(opts[st], closedTags)) return null;
    }
  }

  return Engine.validateAndNormalizePlan(rawPlan, closedTags, unlockedCountries);
}

function promoteNewHostOrCleanup(room) {
  const connectedHumans = room.players.filter(p => !p.isBot && p.connected);
  if (connectedHumans.length === 0) {
    clearRoomTimer(room);
    rooms.delete(room.code);
    return;
  }
  room.hostId = connectedHumans[0].id;
  broadcastRoom(room);
}

// =========================================================================
// WEBSOCKET SERVER + HEARTBEAT + RATE LIMITING
// =========================================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerId = null;
  ws.isBoard = false;
  ws.msgTimestamps = [];

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawBuf) => {
    const now = Date.now();
    ws.msgTimestamps = ws.msgTimestamps.filter(t => now - t < 1000);
    if (ws.msgTimestamps.length >= 30) {
      return; // rate-limit bursts
    }
    ws.msgTimestamps.push(now);

    let msg;
    try {
      if (rawBuf.length > 16384) return;
      msg = JSON.parse(rawBuf.toString('utf8'));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'pong') {
      ws.isAlive = true;
      return;
    }

    if (msg.type === 'host_create') {
      const { room, hostId, hostToken } = createRoom(msg.name, msg.color);
      ws.roomCode = room.code;
      ws.playerId = hostId;
      room.sockets.set(hostId, ws);
      ws.send(JSON.stringify({ type: 'session_created', code: room.code, playerId: hostId, token: hostToken }));
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'join_room') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        return ws.send(JSON.stringify({ type: 'error_msg', message: 'Room code not found.' }));
      }
      if (room.phase !== 'lobby') {
        return ws.send(JSON.stringify({ type: 'error_msg', message: 'Match already in progress. Use your reconnect session if you dropped.' }));
      }
      if (room.players.length >= 8) {
        return ws.send(JSON.stringify({ type: 'error_msg', message: 'Room is full (max 8 players).' }));
      }
      const pid = 'p_' + crypto.randomBytes(4).toString('hex');
      const token = makeToken();
      const usedColors = room.players.map(p => p.color);
      const chosenColor = PLAYER_COLORS.includes(msg.color) && !usedColors.includes(msg.color)
        ? msg.color
        : (PLAYER_COLORS.find(c => !usedColors.includes(c)) || PLAYER_COLORS[room.players.length % PLAYER_COLORS.length]);

      room.players.push({
        id: pid,
        token,
        name: sanitizeName(msg.name),
        color: chosenColor,
        isBot: false,
        botStyle: null,
        connected: true,
        lockedIn: false,
        touchedThisRound: false,
        draftPlan: Engine.createEmptyPlan()
      });
      ws.roomCode = room.code;
      ws.playerId = pid;
      room.sockets.set(pid, ws);
      ws.send(JSON.stringify({ type: 'session_created', code: room.code, playerId: pid, token }));
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'rejoin_room') {
      const code = String(msg.code || '').toUpperCase().trim();
      const token = String(msg.token || '');
      const room = rooms.get(code);
      if (!room) return ws.send(JSON.stringify({ type: 'session_expired' }));
      const player = room.players.find(p => !p.isBot && p.token === token);
      if (!player) return ws.send(JSON.stringify({ type: 'session_expired' }));

      if (player.id === room.hostId && room.hostGraceTimer) {
        clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = null;
      }
      player.connected = true;
      ws.roomCode = room.code;
      ws.playerId = player.id;
      room.sockets.set(player.id, ws);
      ws.send(JSON.stringify({ type: 'session_created', code: room.code, playerId: player.id, token: player.token }));
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'watch_board') {
      const reqCode = String(msg.code || '').toUpperCase().trim();
      let room = reqCode ? rooms.get(reqCode) : null;
      if (!room && rooms.size > 0) {
        room = Array.from(rooms.values())[rooms.size - 1];
      }
      if (!room) {
        return ws.send(JSON.stringify({ type: 'board_waiting', message: 'Waiting for a match to start...' }));
      }
      ws.isBoard = true;
      ws.roomCode = room.code;
      room.boards.add(ws);
      ws.send(JSON.stringify(serializeRoomForClient(room, null)));
      return;
    }

    // Authenticated room actions below
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.playerId) return;
    const player = room.players.find(p => p.id === ws.playerId);
    if (!player) return;
    const isHost = player.id === room.hostId;

    if (msg.type === 'add_bot' && isHost && room.phase === 'lobby') {
      if (room.players.length >= 8) return;
      const styles = ['Cautious', 'Gambler', 'Greedy', 'Adaptive'];
      const style = styles.includes(msg.botStyle) ? msg.botStyle : 'Adaptive';
      const usedColors = room.players.map(p => p.color);
      const color = PLAYER_COLORS.find(c => !usedColors.includes(c)) || PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
      const botCount = room.players.filter(p => p.isBot).length;
      const botName = `${BOT_NAMES[botCount % BOT_NAMES.length]} (${style})`;
      room.players.push({
        id: 'bot_' + crypto.randomBytes(3).toString('hex'),
        token: null,
        name: botName,
        color,
        isBot: true,
        botStyle: style,
        connected: true,
        lockedIn: true,
        touchedThisRound: true,
        draftPlan: Engine.createEmptyPlan()
      });
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'kick_player' && isHost && room.phase === 'lobby') {
      const targetId = String(msg.targetId || '');
      if (targetId === room.hostId) return;
      const idx = room.players.findIndex(p => p.id === targetId);
      if (idx === -1) return;
      const targetSocket = room.sockets.get(targetId);
      if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
        targetSocket.send(JSON.stringify({ type: 'kicked', message: 'Removed from lobby by host.' }));
        targetSocket.roomCode = null;
        targetSocket.playerId = null;
      }
      room.sockets.delete(targetId);
      room.players.splice(idx, 1);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'toggle_early_resolve' && isHost) {
      room.earlyResolveOnAllLocked = !room.earlyResolveOnAllLocked;
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'start_match' && isHost && room.phase === 'lobby') {
      if (room.players.length < 2) {
        return ws.send(JSON.stringify({ type: 'error_msg', message: 'Add at least 1 opponent or AI bot before starting.' }));
      }
      room.leaderboardRecorded = false;
      room.lastRoundSummary = null;
      room.matchState = Engine.createMatchState(room.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        botStyle: p.botStyle
      })));
      startPlanningRound(room);
      return;
    }

    if (msg.type === 'update_plan' && room.phase === 'planning' && !player.lockedIn) {
      const closedTags = room.matchState.briefing.closedTags;
      const unlockedCountries = room.matchState.briefing.unlockedCountries;
      const valid = sanitizePartialDraftPlan(msg.plan, closedTags, unlockedCountries);
      if (!valid) return;
      player.draftPlan = valid;
      player.touchedThisRound = true;
      return;
    }

    if (msg.type === 'lock_in' && room.phase === 'planning') {
      const closedTags = room.matchState.briefing.closedTags;
      const unlockedCountries = room.matchState.briefing.unlockedCountries;
      const valid = validateClientPlan(msg.plan || player.draftPlan, closedTags, unlockedCountries);
      if (!valid) {
        return ws.send(JSON.stringify({ type: 'error_msg', message: 'Complete port, cargo (100%), and route selection before launching.' }));
      }
      player.draftPlan = valid;
      player.touchedThisRound = true;
      player.lockedIn = true;
      broadcastRoom(room);

      if (room.earlyResolveOnAllLocked) {
        const allHumansLocked = room.players
          .filter(p => !p.isBot && p.connected)
          .every(p => p.lockedIn);
        if (allHumansLocked) {
          resolveActivePlanningRound(room);
        }
      }
      return;
    }

    if (msg.type === 'pause_toggle' && isHost && room.phase === 'planning') {
      if (!room.paused) {
        room.paused = true;
        room.pausedRemainingMs = Math.max(1000, room.endsAt - Date.now());
        clearRoomTimer(room);
      } else {
        room.paused = false;
        room.endsAt = Date.now() + room.pausedRemainingMs;
        room.timerHandle = setTimeout(() => resolveActivePlanningRound(room), room.pausedRemainingMs);
        room.pausedRemainingMs = 0;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'skip_reveal' && isHost && room.phase === 'reveal') {
      finishRevealPhase(room);
      return;
    }

    if (msg.type === 'next_round' && isHost && room.phase === 'report') {
      if (room.matchState.finished) {
        room.phase = 'finished';
        broadcastRoom(room);
      } else {
        startPlanningRound(room);
      }
      return;
    }

    if (msg.type === 'reset_match' && isHost) {
      clearRoomTimer(room);
      room.phase = 'lobby';
      room.matchState = null;
      room.lastRoundSummary = null;
      room.leaderboardRecorded = false;
      room.players.forEach(p => {
        p.lockedIn = p.isBot;
        p.touchedThisRound = false;
        p.draftPlan = Engine.createEmptyPlan();
      });
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'new_match' && isHost) {
      clearRoomTimer(room);
      room.lastRoundSummary = null;
      room.leaderboardRecorded = false;
      room.matchState = Engine.createMatchState(room.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        botStyle: p.botStyle
      })));
      startPlanningRound(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.isBoard) {
      room.boards.delete(ws);
      return;
    }
    if (!ws.playerId) return;
    const player = room.players.find(p => p.id === ws.playerId);
    if (!player) return;
    if (room.sockets.get(player.id) === ws) {
      room.sockets.delete(player.id);
      player.connected = false;
      if (player.id === room.hostId) {
        if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = setTimeout(() => {
          const hostNow = room.players.find(p => p.id === room.hostId);
          if (hostNow && !hostNow.connected) {
            promoteNewHostOrCleanup(room);
          }
        }, 20000);
      }
      broadcastRoom(room);
    }
  });
});

// 5-second WebSocket heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', serverTime: Date.now() }));
    }
  });
}, 5000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`Tideline server listening on 0.0.0.0:${PORT}`);
  console.log(`Players on the same Wi-Fi open: http://${lanIp}:${PORT}`);
});
