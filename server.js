require('dotenv').config();
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(cors());

const DEFAULT_DISCONNECT_GRACE_PERIOD_MS = 5 * 60 * 1000;
const configuredDisconnectGracePeriod = process.env.DISCONNECT_GRACE_PERIOD_MS;
const parsedDisconnectGracePeriod = Number(configuredDisconnectGracePeriod);
if (
  configuredDisconnectGracePeriod !== undefined &&
  (!/^\d+$/.test(configuredDisconnectGracePeriod) ||
    !Number.isSafeInteger(parsedDisconnectGracePeriod) ||
    parsedDisconnectGracePeriod < 1)
) {
  throw new RangeError(
    'DISCONNECT_GRACE_PERIOD_MS debe ser un entero positivo y seguro.',
  );
}
const DISCONNECT_GRACE_PERIOD_MS =
  configuredDisconnectGracePeriod === undefined
    ? DEFAULT_DISCONNECT_GRACE_PERIOD_MS
    : parsedDisconnectGracePeriod;
const JWT_SECRET =
  process.env.JWT_SECRET || 'clave_secreta_super_segura_para_el_juego';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
const rooms = new Map();
const TARGET_POINTS = { 2: 26, 3: 24, 4: 22, 5: 21, 6: 20 };

function dbRun(query, values = []) {
  return pool.query(query, values);
}

async function dbGet(query, values = []) {
  const result = await pool.query(query, values);
  return result.rows[0];
}

let databaseReady;
function ensureDatabaseReady() {
  if (!databaseReady) {
    databaseReady = (async () => {
      await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      active_session_id TEXT
    )
  `);
      const result = await pool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'users'`,
      );
      const columns = result.rows.map((row) => row.column_name);
      if (!columns.includes('username') && columns.includes('email')) {
        await dbRun('ALTER TABLE users RENAME COLUMN email TO username');
      } else if (!columns.includes('username')) {
        throw new Error('La tabla users no contiene una columna username válida.');
      }
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id TEXT',
      );
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_points INTEGER NOT NULL DEFAULT 1000',
      );
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_games INTEGER NOT NULL DEFAULT 0',
      );
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INTEGER NOT NULL DEFAULT 0',
      );
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0',
      );
      await dbRun(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0',
      );
      await dbRun(
        'ALTER TABLE users ALTER COLUMN ranked_points SET DEFAULT 1000',
      );
      await dbRun(
        'UPDATE users SET ranked_points = 1000 WHERE ranked_points = 0 AND ranked_games = 0',
      );
      await dbRun(
        'CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx ON users (username)',
      );
    })();
  }
  return databaseReady;
}

const INITIAL_ELO = 1000;
const MIN_ELO = 100;
const ELO_K_PROVISIONAL = 40;
const ELO_K_NORMAL = 32;
const ELO_K_MASTER = 24;

function getRankedLevel(elo = INITIAL_ELO) {
  const safeElo = Math.max(0, Number(elo) || 0);
  if (safeElo >= 1500) return 'EL Brilliant';
  if (safeElo >= 1300) return 'Megamente';
  if (safeElo >= 1150) return 'Experto';
  if (safeElo >= 1000) return 'Nuevo héroe';
  return 'Principiante';
}

function getRankedTier(elo = INITIAL_ELO) {
  const safeElo = Math.max(0, Number(elo) || 0);
  if (safeElo >= 1500) return 4;
  if (safeElo >= 1300) return 3;
  if (safeElo >= 1150) return 2;
  if (safeElo >= 1000) return 1;
  return 0;
}

function getEloKFactor(elo = INITIAL_ELO, rankedGames = 0) {
  const games = Math.max(0, Number(rankedGames) || 0);
  const safeElo = Math.max(MIN_ELO, Number(elo) || INITIAL_ELO);
  if (games < 10) return ELO_K_PROVISIONAL;
  if (safeElo >= 1500) return ELO_K_MASTER;
  return ELO_K_NORMAL;
}

function calculateMultiplayerEloResults(players = [], winnerId = null) {
  const results = new Map();
  if (!Array.isArray(players) || players.length < 2) {
    for (const player of players || []) {
      results.set(String(player.id), { delta: 0, compensation: null });
    }
    return results;
  }

  const opponentCount = players.length - 1;
  for (const player of players) {
    const playerId = String(player.id);
    const ownElo = Math.max(
      MIN_ELO,
      Number(player.rankedPoints ?? player.elo ?? INITIAL_ELO) || INITIAL_ELO,
    );
    const ownTier = getRankedTier(ownElo);
    const ownScore = Number(player.score) || 0;
    const kFactor = getEloKFactor(ownElo, player.rankedGames ?? 0);

    let scoreDiffSum = 0;
    let maxHigherPtsGapOnLoss = 0;
    let maxHigherTierGapOnLoss = 0;
    let beatOpponent200Above = false;

    for (const opponent of players) {
      const opponentId = String(opponent.id);
      if (opponentId === playerId) continue;

      const oppElo = Math.max(
        MIN_ELO,
        Number(opponent.rankedPoints ?? opponent.elo ?? INITIAL_ELO) ||
          INITIAL_ELO,
      );
      const oppTier = getRankedTier(oppElo);
      const oppScore = Number(opponent.score) || 0;
      const expected = 1 / (1 + 10 ** ((oppElo - ownElo) / 400));

      let actual;
      if (ownScore > oppScore) {
        actual = 1;
      } else if (ownScore < oppScore) {
        actual = 0;
      } else if (winnerId != null && String(winnerId) === playerId) {
        actual = 1;
      } else if (winnerId != null && String(winnerId) === opponentId) {
        actual = 0;
      } else {
        actual = 0.5;
      }

      const ptsGap = oppElo - ownElo;
      const tierGap = oppTier - ownTier;
      if (actual === 0) {
        if (ptsGap > maxHigherPtsGapOnLoss) maxHigherPtsGapOnLoss = ptsGap;
        if (tierGap > maxHigherTierGapOnLoss) maxHigherTierGapOnLoss = tierGap;
      } else if (actual === 1 && ptsGap >= 200) {
        beatOpponent200Above = true;
      }

      scoreDiffSum += actual - expected;
    }

    let rawDelta = Math.round((kFactor / opponentCount) * scoreDiffSum);
    let compensation = null;

    if (rawDelta < 0) {
      if (maxHigherPtsGapOnLoss >= 300 || maxHigherTierGapOnLoss >= 2) {
        rawDelta = 0;
        compensation = 'Escudo por diferencia de nivel (0 pts perdidos)';
      } else if (maxHigherPtsGapOnLoss >= 200) {
        rawDelta = -Math.round(Math.abs(rawDelta) * 0.5);
        compensation = 'Compensación por diferencia de nivel (-50% pérdida)';
      }
    } else if (rawDelta > 0 && beatOpponent200Above) {
      rawDelta = Math.round(rawDelta * 1.2);
      compensation = 'Bono +20% por vencer a rival superior';
    }

    const nextElo = Math.max(MIN_ELO, ownElo + rawDelta);
    results.set(playerId, { delta: nextElo - ownElo, compensation });
  }

  return results;
}

function calculateMultiplayerEloDeltas(players = [], winnerId = null) {
  const results = calculateMultiplayerEloResults(players, winnerId);
  const deltas = new Map();
  for (const [id, item] of results.entries()) {
    deltas.set(id, item.delta);
  }
  return deltas;
}

function calculateRankedDelta({
  matchScore,
  playerRankedPoints = INITIAL_ELO,
  playerRankedGames = 0,
  opponentRankedPoints = [],
  opponentScores = [],
  isWinner = false,
  winnerMatchScore,
}) {
  const opponents = opponentRankedPoints.map((oppElo, index) => ({
    id: `opp-${index}`,
    rankedPoints: oppElo,
    rankedGames: 0,
    score:
      opponentScores[index] !== undefined
        ? opponentScores[index]
        : isWinner
          ? Math.max(0, (Number(matchScore) || 0) - 1)
          : Math.max((Number(matchScore) || 0) + 1, Number(winnerMatchScore) || 1),
  }));
  const participants = [
    {
      id: 'self',
      rankedPoints: playerRankedPoints,
      rankedGames: playerRankedGames,
      score: Number(matchScore) || 0,
    },
    ...opponents,
  ];
  return (
    calculateMultiplayerEloDeltas(participants, isWinner ? 'self' : null).get(
      'self',
    ) ?? 0
  );
}

function getTargetPoints(playerCount) {
  const target = TARGET_POINTS[playerCount];
  if (!target) {
    throw new RangeError('La sala debe tener entre 2 y 6 jugadores.');
  }
  return target;
}

function getZoneAward(pointValues, claimCount) {
  if (!Array.isArray(pointValues) || pointValues.length === 0) {
    throw new TypeError('La zona no tiene una bolsa de puntos válida.');
  }
  return pointValues[Math.min(claimCount, pointValues.length - 1)];
}

function getDecodedToken(req, res) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }

  try {
    return jwt.verify(authorization.slice('Bearer '.length), JWT_SECRET);
  } catch {
    res.status(403).json({ error: 'Token inválido o expirado' });
    return null;
  }
}

async function getActiveRequestUser(req, res) {
  const decoded = getDecodedToken(req, res);
  if (!decoded) return null;
  if (!decoded.sessionId) {
    res.status(401).json({ error: 'Esta sesión ya no está activa' });
    return null;
  }

  await ensureDatabaseReady();
  const activeUser = await dbGet(
    'SELECT id FROM users WHERE id = $1 AND active_session_id = $2',
    [decoded.id, decoded.sessionId],
  );
  if (!activeUser) {
    res.status(401).json({ error: 'Esta sesión ya no está activa' });
    return null;
  }

  return decoded;
}

// REGISTRO
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  await ensureDatabaseReady();
  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await dbRun(
    `INSERT INTO users (username, password)
     VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [username, hashedPassword],
  );
  if (result.rowCount === 0) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }

  res.status(201).json({ message: 'Cuenta creada exitosamente' });
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  await ensureDatabaseReady();
  const user = await dbGet(
    'SELECT id, username, password FROM users WHERE username = $1',
    [username],
  );

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  const sessionId = crypto.randomUUID();
  const result = await dbRun(
    `UPDATE users
     SET active_session_id = $2
     WHERE id = $1 AND active_session_id IS NULL
     RETURNING id`,
    [user.id, sessionId],
  );
  if (result.rowCount === 0) {
    return res.status(409).json({
      code: 'SESSION_ACTIVE',
      error: 'Esta cuenta ya tiene una sesión activa. Cierra sesión en el otro dispositivo.',
    });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, sessionId },
    JWT_SECRET,
  );
  res.json({ message: 'Login exitoso', token });
});

app.post('/api/login/recover', async (req, res) => {
  const { username, password } = req.body;
  await ensureDatabaseReady();
  const user = await dbGet(
    'SELECT id, username, password, active_session_id FROM users WHERE username = $1',
    [username],
  );

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  if (!user.active_session_id) {
    return res.status(409).json({
      error: 'No hay una sesión activa que recuperar. Inicia sesión normalmente.',
    });
  }

  const previousSessionId = user.active_session_id;
  const sessionId = crypto.randomUUID();
  const result = await dbRun(
    `UPDATE users
     SET active_session_id = $3
     WHERE id = $1 AND active_session_id = $2
     RETURNING id`,
    [user.id, previousSessionId, sessionId],
  );
  if (result.rowCount === 0) {
    return res.status(409).json({
      error: 'La sesión ya cambió. Intenta iniciar sesión nuevamente.',
    });
  }

  disconnectUserSession(previousSessionId);
  const token = jwt.sign(
    { id: user.id, username: user.username, sessionId },
    JWT_SECRET,
  );
  res.json({ message: 'Sesión anterior cerrada', token });
});

app.get('/api/session', async (req, res) => {
  const user = await getActiveRequestUser(req, res);
  if (!user) return;
  res.json({ username: user.username });
});

app.get('/api/profile', async (req, res) => {
  const user = await getActiveRequestUser(req, res);
  if (!user) return;
  const row = await dbGet(
    'SELECT username, ranked_points, ranked_games, games_played, wins, current_streak FROM users WHERE id = $1',
    [user.id],
  );
  const storedElo = Number(row?.ranked_points);
  const rankedPoints =
    Number.isFinite(storedElo) && storedElo >= MIN_ELO
      ? storedElo
      : INITIAL_ELO;
  res.json({
    username: row?.username || user.username,
    rankedPoints,
    rankedLevel: getRankedLevel(rankedPoints),
    rankedGames: Math.max(0, Number(row?.ranked_games) || 0),
    gamesPlayed: Math.max(0, Number(row?.games_played) || 0),
    wins: Math.max(0, Number(row?.wins) || 0),
    currentStreak: Math.max(0, Number(row?.current_streak) || 0),
  });
});

app.post('/api/logout', async (req, res) => {
  const user = await getActiveRequestUser(req, res);
  if (!user) return;

  await dbRun(
    'UPDATE users SET active_session_id = NULL WHERE id = $1 AND active_session_id = $2',
    [user.id, user.sessionId],
  );
  disconnectUserSession(user.sessionId);
  res.json({ message: 'Sesión cerrada exitosamente' });
});

// BORRAR CUENTA
app.delete('/api/delete-account', async (req, res) => {
  const user = await getActiveRequestUser(req, res);
  if (!user) return;
  await dbRun('DELETE FROM users WHERE id = $1', [user.id]);
  disconnectUserSession(user.sessionId);
  res.json({ message: 'Cuenta eliminada permanentemente' });
});

app.use((error, req, res, next) => {
  console.error('Error procesando la solicitud:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

function disconnectUserSession(sessionId) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user?.sessionId === sessionId) {
      socket.disconnect(true);
    }
  }
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Inicia sesión para entrar a una sala.'));
  }

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    next(new Error('Sesión inválida o expirada. Vuelve a iniciar sesión.'));
    return;
  }

  try {
    await ensureDatabaseReady();
    const activeUser = await dbGet(
      'SELECT id, ranked_points, ranked_games FROM users WHERE id = $1 AND active_session_id = $2',
      [user.id, user.sessionId],
    );
    if (!activeUser) {
      next(new Error('Esta sesión ya no está activa. Vuelve a iniciar sesión.'));
      return;
    }
    const storedElo = Number(activeUser.ranked_points);
    const storedGames = Math.max(0, Number(activeUser.ranked_games) || 0);
    socket.data.user = {
      ...user,
      rankedPoints:
        Number.isFinite(storedElo) && storedElo >= MIN_ELO
          ? storedElo
          : INITIAL_ELO,
      rankedGames: storedGames,
    };
    next();
  } catch (error) {
    next(error);
  }
});

function rollDice() {
  return [crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
}

function getRoomForSocket(socket) {
  const room = rooms.get(socket.data.roomCode);
  const player = room?.players.get(String(socket.data.user.id));
  if (!room || !player || player.socketId !== socket.id) {
    throw new Error('No estás en una sala activa.');
  }
  return room;
}

function roomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    capacity: room.capacity,
    boardId: room.boardId,
    targetPoints: room.targetPoints,
    status: room.status,
    ranked: Boolean(room.ranked),
    timeTrial: Boolean(room.timeTrial),
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      username: player.username,
      ready: player.ready,
      connected: player.connected,
      score: player.score,
      finished: player.finished,
      setupComplete: player.setupComplete,
      rankedPoints: player.rankedPoints ?? INITIAL_ELO,
      rankedDelta: player.rankedDelta ?? null,
      rankedCompensation: player.rankedCompensation ?? null,
      rankedGames: player.rankedGames ?? 0,
      rankedLevel: getRankedLevel(player.rankedPoints ?? INITIAL_ELO),
    })),
  };
}

function gameSnapshot(room, playerId) {
  const snapshot = {
    room: roomSummary(room),
    turn: room.turn,
    dice: room.dice,
    phase: room.phase,
    setupCompletePlayerIds: [...room.players.values()]
      .filter((player) => player.setupComplete)
      .map((player) => player.id),
    completedPlayerIds: [...room.completedPlayerIds],
    zoneClaims: Object.fromEntries(
      [...room.zoneClaims.entries()].map(([zoneId, claims]) => [
        zoneId,
        claims,
      ]),
    ),
    winnerId: room.winnerId,
  };
  if (playerId !== undefined) {
    snapshot.ownBoard = room.players.get(String(playerId))?.board || null;
  }
  if (room.status === 'finished') {
    snapshot.playerBoards = Object.fromEntries(
      [...room.players.values()]
        .filter((player) => Array.isArray(player.board))
        .map((player) => [player.id, [...player.board]]),
    );
  }
  return snapshot;
}

function broadcastRoom(room) {
  io.to(room.code).emit('lobby:update', roomSummary(room));
}

function broadcastGame(room) {
  io.to(room.code).emit('game:state', gameSnapshot(room));
}

function cancelDisconnectTimer(room, playerId) {
  const timer = room.disconnectTimers.get(playerId);
  if (timer) clearTimeout(timer);
  room.disconnectTimers.delete(playerId);
}

function finishRoom(room, winnerId) {
  room.status = 'finished';
  room.winnerId = winnerId;
  for (const timer of room.disconnectTimers.values()) {
    clearTimeout(timer);
  }
  room.disconnectTimers.clear();

  if (room.players.size >= 2) {
    const players = [...room.players.values()];
    const results = room.ranked
      ? calculateMultiplayerEloResults(players, winnerId)
      : null;

    for (const player of players) {
      const won = winnerId != null && String(player.id) === String(winnerId);
      if (room.ranked && results) {
        const ownInitial = Math.max(
          MIN_ELO,
          Number(player.rankedPoints ?? INITIAL_ELO) || INITIAL_ELO,
        );
        const result = results.get(String(player.id)) ?? {
          delta: 0,
          compensation: null,
        };
        player.rankedDelta = result.delta;
        player.rankedCompensation = result.compensation;
        player.rankedPoints = Math.max(MIN_ELO, ownInitial + result.delta);
        player.rankedGames = Math.max(0, Number(player.rankedGames) || 0) + 1;
        dbRun(
          `UPDATE users
           SET ranked_points = $2,
               ranked_games = $3,
               games_played = games_played + 1,
               wins = wins + $4,
               current_streak = CASE WHEN $4 = 1 THEN current_streak + 1 ELSE 0 END
           WHERE id = $1`,
          [player.id, player.rankedPoints, player.rankedGames, won ? 1 : 0],
        ).catch(() => {});
      } else {
        dbRun(
          `UPDATE users
           SET games_played = games_played + 1,
               wins = wins + $2,
               current_streak = CASE WHEN $2 = 1 THEN current_streak + 1 ELSE 0 END
           WHERE id = $1`,
          [player.id, won ? 1 : 0],
        ).catch(() => {});
      }
    }
  }
}

function startGameIfReady(room) {
  const shouldStart =
    room.status === 'waiting' &&
    room.players.size === room.capacity &&
    [...room.players.values()].every(
      (player) => player.connected && player.ready,
    );
  if (!shouldStart) return false;

  room.status = 'playing';
  room.phase = 'setup';
  room.turn = 1;
  room.dice = rollDice();
  room.zoneClaims = new Map();
  room.completedPlayerIds = new Set();
  return true;
}

function advanceTurnIfConnectedPlayersCompleted(room) {
  if (room.status !== 'playing' || room.phase !== 'playing') return;

  const connectedPlayers = [...room.players.values()].filter(
    (player) => player.connected && !player.finished,
  );
  if (
    connectedPlayers.length > 0 &&
    connectedPlayers.every((player) => room.completedPlayerIds.has(player.id))
  ) {
    room.turn += 1;
    room.dice = rollDice();
    room.completedPlayerIds = new Set();
  }
}

function handleDisconnectGracePeriodExpired(room, playerId) {
  room.disconnectTimers.delete(playerId);
  if (rooms.get(room.code) !== room) return;

  const player = room.players.get(playerId);
  if (!player || player.connected) return;

  if (room.status === 'waiting') {
    removePlayerFromWaitingRoom(room, playerId);
    return;
  }
  if (room.status !== 'playing') return;

  player.finished = true;
  const playersStillInGame = [...room.players.values()].filter(
    (item) => !item.finished,
  );
  const connectedPlayers = playersStillInGame.filter(
    (item) => item.connected,
  );
  if (playersStillInGame.length === 1 && connectedPlayers.length === 1) {
    finishRoom(room, connectedPlayers[0].id);
  } else if (connectedPlayers.length > 0) {
    if (
      room.phase === 'setup' &&
      playersStillInGame.every((item) => item.setupComplete)
    ) {
      room.phase = 'playing';
    }
    advanceTurnIfConnectedPlayersCompleted(room);
  } else if (playersStillInGame.length === 0) {
    finishRoom(room, null);
  }

  broadcastGame(room);
}

function startDisconnectGracePeriod(room, playerId) {
  cancelDisconnectTimer(room, playerId);
  const timer = setTimeout(
    () => handleDisconnectGracePeriodExpired(room, playerId),
    DISCONNECT_GRACE_PERIOD_MS,
  );
  timer.unref?.();
  room.disconnectTimers.set(playerId, timer);
}

function validateSetupBoard(board) {
  if (
    !Array.isArray(board) ||
    board.length !== 49 ||
    board.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 6,
    )
  ) {
    throw new Error('El estado del tablero no es válido.');
  }

  const startingNumbers = board.filter((value) => value !== 0);
  if (
    startingNumbers.length !== 6 ||
    new Set(startingNumbers).size !== 6 ||
    ![1, 2, 3, 4, 5, 6].every((number) =>
      startingNumbers.includes(number),
    )
  ) {
    throw new Error('Debes colocar una vez cada número del 1 al 6.');
  }
}

function removePlayerFromWaitingRoom(room, playerId) {
  cancelDisconnectTimer(room, playerId);
  room.players.delete(playerId);
  if (room.players.size === 0) {
    for (const timer of room.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    room.disconnectTimers.clear();
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastRoom(room);
}

function cleanupStaleRoomsForUser(userId, targetRoomCode = null) {
  for (const existingRoom of [...rooms.values()]) {
    if (existingRoom.code === targetRoomCode) continue;
    if (existingRoom.status === 'finished') continue;
    const player = existingRoom.players.get(userId);
    if (!player) continue;

    if (existingRoom.status === 'waiting') {
      removePlayerFromWaitingRoom(existingRoom, userId);
    } else if (!player.connected || player.finished) {
      cancelDisconnectTimer(existingRoom, userId);
      existingRoom.players.delete(userId);
      existingRoom.completedPlayerIds.delete(userId);
      const playersStillInGame = [...existingRoom.players.values()].filter(
        (item) => !item.finished,
      );
      const connectedPlayers = playersStillInGame.filter(
        (item) => item.connected,
      );
      if (existingRoom.players.size === 0) {
        rooms.delete(existingRoom.code);
      } else if (
        playersStillInGame.length === 1 &&
        connectedPlayers.length === 1
      ) {
        finishRoom(existingRoom, connectedPlayers[0].id);
        broadcastGame(existingRoom);
      } else if (connectedPlayers.length > 0) {
        if (
          existingRoom.phase === 'setup' &&
          playersStillInGame.every((item) => item.setupComplete)
        ) {
          existingRoom.phase = 'playing';
        }
        advanceTurnIfConnectedPlayersCompleted(existingRoom);
        broadcastGame(existingRoom);
      } else if (playersStillInGame.length === 0) {
        finishRoom(existingRoom, null);
        broadcastGame(existingRoom);
      }
    }
  }
}

io.on('connection', (socket) => {
  socket.data.user.id = String(socket.data.user.id);

  function acknowledge(ack, result) {
    if (typeof ack === 'function') ack({ ok: true, ...result });
  }

  function fail(ack, error) {
    const message = error instanceof Error ? error.message : 'Error del servidor.';
    if (typeof ack === 'function') {
      ack({ ok: false, error: message });
    } else {
      socket.emit('app:error', message);
    }
  }

  socket.on('lobby:create', (payload = {}, ack) => {
    try {
      const capacity = Number(payload.capacity);
      const boardId = Number(payload.boardId);
      const pointValues = payload.zonePointValues;
      const targetPoints = getTargetPoints(capacity);
      if (!Number.isInteger(boardId) || boardId < 1 || boardId > 4) {
        throw new Error('Selecciona un tablero válido.');
      }
      if (
        !Array.isArray(pointValues) ||
        pointValues.length === 0 ||
        pointValues.some(
          (values) =>
            !Array.isArray(values) ||
            values.length === 0 ||
            values.some((value) => !Number.isInteger(value) || value < 0),
        )
      ) {
        throw new Error('El tablero no incluye sus bolsas de puntos.');
      }

      const user = socket.data.user;
      cleanupStaleRoomsForUser(user.id);
      const alreadyPlaying = [...rooms.values()].some(
        (room) => room.players.has(user.id) && room.status !== 'finished',
      );
      if (alreadyPlaying) throw new Error('Ya estás participando en una sala.');

      let code;
      do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase();
      } while (rooms.has(code));

      const ranked = payload.ranked === true;
      const timeTrial = payload.timeTrial === true;
      const userRankedPoints = Math.max(
        MIN_ELO,
        Number(payload.rankedPoints ?? user.rankedPoints ?? INITIAL_ELO) ||
          INITIAL_ELO,
      );
      const userRankedGames = Math.max(
        0,
        Number(payload.rankedGames ?? user.rankedGames) || 0,
      );
      user.rankedPoints = userRankedPoints;
      user.rankedGames = userRankedGames;

      const room = {
        code,
        hostId: user.id,
        capacity,
        boardId,
        targetPoints,
        zonePointValues: pointValues,
        status: 'waiting',
        ranked,
        timeTrial,
        players: new Map([
          [
            user.id,
            {
              id: user.id,
              username: user.username,
              ready: false,
              connected: true,
              socketId: socket.id,
              score: 0,
              finished: false,
              setupComplete: false,
              board: null,
              rankedPoints: userRankedPoints,
              rankedGames: userRankedGames,
              rankedDelta: null,
            },
          ],
        ]),
        turn: 0,
        dice: null,
        completedPlayerIds: new Set(),
        zoneClaims: new Map(),
        disconnectTimers: new Map(),
        winnerId: null,
      };
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      acknowledge(ack, { room: roomSummary(room), playerId: user.id });
      broadcastRoom(room);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('lobby:join', (payload = {}, ack) => {
    try {
      const code = String(payload.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room || room.status === 'finished') {
        throw new Error('No se encontró una sala disponible con ese código.');
      }

      const user = socket.data.user;
      const existingPlayer = room.players.get(user.id);
      if (existingPlayer?.finished) {
        throw new Error(
          'El tiempo para reconectarte terminó y quedaste fuera de la partida.',
        );
      }
      if (!existingPlayer && room.status !== 'waiting') {
        throw new Error('La partida ya comenzó.');
      }
      if (!existingPlayer && room.players.size >= room.capacity) {
        throw new Error('La sala está llena.');
      }

      cleanupStaleRoomsForUser(user.id, room.code);
      const alreadyPlaying = [...rooms.values()].some(
        (otherRoom) =>
          otherRoom.code !== room.code &&
          otherRoom.players.has(user.id) &&
          otherRoom.status !== 'finished',
      );
      if (alreadyPlaying) throw new Error('Ya estás participando en otra sala.');

      const userRankedPoints = Math.max(
        MIN_ELO,
        Number(payload.rankedPoints ?? user.rankedPoints ?? INITIAL_ELO) ||
          INITIAL_ELO,
      );
      const userRankedGames = Math.max(
        0,
        Number(payload.rankedGames ?? user.rankedGames) || 0,
      );
      user.rankedPoints = userRankedPoints;
      user.rankedGames = userRankedGames;

      if (existingPlayer) {
        cancelDisconnectTimer(room, user.id);
        existingPlayer.connected = true;
        existingPlayer.socketId = socket.id;
      } else {
        room.players.set(user.id, {
          id: user.id,
          username: user.username,
          ready: false,
          connected: true,
          socketId: socket.id,
          score: 0,
          finished: false,
          setupComplete: false,
          board: null,
          rankedPoints: userRankedPoints,
          rankedGames: userRankedGames,
          rankedDelta: null,
        });
      }

      socket.join(code);
      socket.data.roomCode = code;
      const started = startGameIfReady(room);
      acknowledge(ack, { room: roomSummary(room), playerId: user.id });
      if (started) {
        io.to(room.code).emit('game:start', gameSnapshot(room));
      } else if (room.status === 'playing') {
        socket.emit('game:state', gameSnapshot(room, user.id));
        broadcastGame(room);
      } else {
        broadcastRoom(room);
      }
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('lobby:board', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.status !== 'waiting') {
        throw new Error('El tablero no se puede cambiar después de iniciar la partida.');
      }
      if (room.hostId !== socket.data.user.id) {
        throw new Error('Solo el anfitrión puede cambiar el tablero.');
      }

      const boardId = Number(payload.boardId);
      const pointValues = payload.zonePointValues;
      if (!Number.isInteger(boardId) || boardId < 1 || boardId > 4) {
        throw new Error('Selecciona un tablero válido.');
      }
      if (
        !Array.isArray(pointValues) ||
        pointValues.length === 0 ||
        pointValues.some(
          (values) =>
            !Array.isArray(values) ||
            values.length === 0 ||
            values.some((value) => !Number.isInteger(value) || value < 0),
        )
      ) {
        throw new Error('El tablero no incluye sus bolsas de puntos.');
      }

      if (boardId !== room.boardId) {
        room.boardId = boardId;
        room.zonePointValues = pointValues;
        for (const player of room.players.values()) {
          player.ready = false;
        }
      }
      acknowledge(ack, { room: roomSummary(room) });
      broadcastRoom(room);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('lobby:ready', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.status !== 'waiting') {
        throw new Error('La partida ya comenzó.');
      }
      const player = room.players.get(socket.data.user.id);
      player.ready = payload.ready === true;
      const shouldStart = startGameIfReady(room);
      acknowledge(ack, { room: roomSummary(room) });
      broadcastRoom(room);
      if (shouldStart) {
        io.to(room.code).emit('game:start', gameSnapshot(room));
      }
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('game:setup-complete', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.status !== 'playing') {
        throw new Error('La configuración inicial ya terminó.');
      }

      const player = room.players.get(socket.data.user.id);
      if (player.setupComplete) {
        throw new Error('Ya confirmaste tu tablero inicial.');
      }
      validateSetupBoard(payload.board);
      player.board = [...payload.board];
      player.setupComplete = true;

      if ([...room.players.values()].every((item) => item.setupComplete)) {
        room.phase = 'playing';
      }

      const snapshot = gameSnapshot(room, player.id);
      acknowledge(ack, { state: snapshot });
      broadcastGame(room);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('game:turn-complete', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.status !== 'playing') throw new Error('La partida no está activa.');
      if (
        room.phase !== 'playing' ||
        [...room.players.values()].some((item) => !item.setupComplete)
      ) {
        throw new Error('Espera a que todos configuren su tablero inicial.');
      }

      const playerId = socket.data.user.id;
      const player = room.players.get(playerId);
      if (player.finished) throw new Error('Ya terminaste la partida.');
      if (room.completedPlayerIds.has(playerId)) {
        throw new Error('Ya completaste este turno. Espera a los demás jugadores.');
      }

      if (
        !Array.isArray(payload.board) ||
        payload.board.length !== 49 ||
        payload.board.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 6,
        )
      ) {
        throw new Error('El estado del tablero no es válido.');
      }
      player.board = payload.board;

      const requestedClaims = Array.isArray(payload.completedZones)
        ? payload.completedZones
        : [];
      for (const zoneId of requestedClaims) {
        if (
          !Number.isInteger(zoneId) ||
          zoneId < 0 ||
          zoneId >= room.zonePointValues.length
        ) {
          continue;
        }
        const claims = room.zoneClaims.get(zoneId) || [];
        if (claims.some((claim) => claim.playerId === playerId)) continue;

        const points = getZoneAward(
          room.zonePointValues[zoneId],
          claims.length,
        );
        claims.push({ playerId, username: player.username, points });
        room.zoneClaims.set(zoneId, claims);
        player.score += points;
      }

      if (payload.finished === true) player.finished = true;
      room.completedPlayerIds.add(playerId);

      if (player.score >= room.targetPoints) {
        finishRoom(room, playerId);
      } else {
        const remainingPlayers = [...room.players.values()].filter(
          (item) => !item.finished,
        );
        if (remainingPlayers.length === 0) {
          finishRoom(
            room,
            [...room.players.values()].sort(
              (left, right) => right.score - left.score,
            )[0].id,
          );
        } else {
          advanceTurnIfConnectedPlayersCompleted(room);
        }
      }

      if (room.ranked) {
        for (const player of room.players.values()) {
          if (player.id === socket.data.user.id) {
            socket.data.user.rankedPoints = player.rankedPoints;
            socket.data.user.rankedGames = player.rankedGames;
          }
        }
      }

      const snapshot = gameSnapshot(room);
      acknowledge(ack, { state: snapshot });
      broadcastGame(room);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('lobby:leave', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      const playerId = socket.data.user.id;
      socket.leave(room.code);
      delete socket.data.roomCode;
      if (room.status === 'waiting') {
        removePlayerFromWaitingRoom(room, playerId);
      } else {
        const player = room.players.get(playerId);
        player.connected = false;
        player.socketId = null;
        startDisconnectGracePeriod(room, playerId);
        advanceTurnIfConnectedPlayersCompleted(room);
        broadcastGame(room);
      }
      acknowledge(ack, {});
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.data.user.id);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = null;
    player.connected = false;
    if (room.status === 'waiting') {
      removePlayerFromWaitingRoom(room, player.id);
    } else if (room.status === 'playing') {
      startDisconnectGracePeriod(room, player.id);
      advanceTurnIfConnectedPlayersCompleted(room);
      broadcastGame(room);
    }
  });
});

async function start() {
  const port = process.env.PORT || 3000;
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.removeListener('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.removeListener('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, '0.0.0.0');
  });
  console.log(`Servidor corriendo en el puerto ${port}`);

  try {
    await ensureDatabaseReady();
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Error al iniciar el servidor:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  io,
  pool,
  rooms,
  getTargetPoints,
  getZoneAward,
  INITIAL_ELO,
  MIN_ELO,
  getRankedLevel,
  getRankedTier,
  getEloKFactor,
  calculateMultiplayerEloResults,
  calculateMultiplayerEloDeltas,
  calculateRankedDelta,
  DEFAULT_DISCONNECT_GRACE_PERIOD_MS,
  DISCONNECT_GRACE_PERIOD_MS,
  start,
};
