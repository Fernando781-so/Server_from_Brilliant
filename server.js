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
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
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
    })();
  }
  return databaseReady;
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

// REGISTRO
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  await ensureDatabaseReady();
  const existingUser = await dbGet(
    'SELECT id FROM users WHERE username = $1',
    [username],
  );
  if (existingUser) {
    return res.status(400).json({ error: 'El usuario ya existe' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await dbRun(
      'INSERT INTO users (username, password) VALUES ($1, $2)',
      [username, hashedPassword],
    );
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    throw error;
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

  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '2h' },
  );
  res.json({ message: 'Login exitoso', token });
});

// BORRAR CUENTA
app.delete('/api/delete-account', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No autorizado' });

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Token inválido o expirado' });
  }
  await ensureDatabaseReady();
  await dbRun('DELETE FROM users WHERE id = $1', [decoded.id]);
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

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) throw new Error('Inicia sesión para entrar a una sala.');
    socket.data.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    next(new Error('Sesión inválida o expirada. Vuelve a iniciar sesión.'));
  }
});

function rollDice() {
  return [crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
}

function getRoomForSocket(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room || !room.players.has(String(socket.data.user.id))) {
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
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      username: player.username,
      ready: player.ready,
      connected: player.connected,
      score: player.score,
      finished: player.finished,
    })),
  };
}

function gameSnapshot(room, playerId) {
  const snapshot = {
    room: roomSummary(room),
    turn: room.turn,
    dice: room.dice,
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
  return snapshot;
}

function broadcastRoom(room) {
  io.to(room.code).emit('lobby:update', roomSummary(room));
}

function broadcastGame(room) {
  io.to(room.code).emit('game:state', gameSnapshot(room));
}

function advanceTurnIfConnectedPlayersCompleted(room) {
  if (room.status !== 'playing') return;

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

function removePlayerFromWaitingRoom(room, playerId) {
  room.players.delete(playerId);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastRoom(room);
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
      const alreadyPlaying = [...rooms.values()].some(
        (room) => room.players.has(user.id) && room.status !== 'finished',
      );
      if (alreadyPlaying) throw new Error('Ya estás participando en una sala.');

      let code;
      do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase();
      } while (rooms.has(code));

      const room = {
        code,
        hostId: user.id,
        capacity,
        boardId,
        targetPoints,
        zonePointValues: pointValues,
        status: 'waiting',
        players: new Map([
          [
            user.id,
            {
              id: user.id,
              username: user.username,
              ready: false,
              connected: true,
              score: 0,
              finished: false,
              board: null,
            },
          ],
        ]),
        turn: 0,
        dice: null,
        completedPlayerIds: new Set(),
        zoneClaims: new Map(),
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
      if (!existingPlayer && room.status !== 'waiting') {
        throw new Error('La partida ya comenzó.');
      }
      if (!existingPlayer && room.players.size >= room.capacity) {
        throw new Error('La sala está llena.');
      }

      const alreadyPlaying = [...rooms.values()].some(
        (otherRoom) =>
          otherRoom.code !== room.code &&
          otherRoom.players.has(user.id) &&
          otherRoom.status !== 'finished',
      );
      if (alreadyPlaying) throw new Error('Ya estás participando en otra sala.');

      if (existingPlayer) {
        existingPlayer.connected = true;
      } else {
        room.players.set(user.id, {
          id: user.id,
          username: user.username,
          ready: false,
          connected: true,
          score: 0,
          finished: false,
          board: null,
        });
      }

      socket.join(code);
      socket.data.roomCode = code;
      acknowledge(ack, { room: roomSummary(room), playerId: user.id });
      if (room.status === 'playing') {
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
      const shouldStart =
        room.players.size === room.capacity &&
        [...room.players.values()].every((item) => item.ready);
      if (shouldStart) {
        room.status = 'playing';
        room.turn = 1;
        room.dice = rollDice();
        room.zoneClaims = new Map();
        room.completedPlayerIds = new Set();
      }
      acknowledge(ack, { room: roomSummary(room) });
      broadcastRoom(room);
      if (shouldStart) {
        io.to(room.code).emit('game:start', gameSnapshot(room));
      }
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('game:turn-complete', (payload = {}, ack) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.status !== 'playing') throw new Error('La partida no está activa.');

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
        room.status = 'finished';
        room.winnerId = playerId;
      } else {
        const remainingPlayers = [...room.players.values()].filter(
          (item) => !item.finished,
        );
        if (remainingPlayers.length === 0) {
          room.status = 'finished';
          room.winnerId = [...room.players.values()].sort(
            (left, right) => right.score - left.score,
          )[0].id;
        } else {
          advanceTurnIfConnectedPlayersCompleted(room);
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
    if (!player) return;
    if (room.status === 'waiting') {
      removePlayerFromWaitingRoom(room, player.id);
    } else if (room.status === 'playing') {
      player.connected = false;
      advanceTurnIfConnectedPlayersCompleted(room);
      broadcastGame(room);
    }
  });
});

async function start() {
  await ensureDatabaseReady();
  const port = process.env.PORT || 3000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      console.log(`Servidor corriendo en el puerto ${port}`);
      resolve();
    });
  });
}

if (require.main === module) start();

module.exports = {
  app,
  server,
  io,
  rooms,
  getTargetPoints,
  getZoneAward,
  start,
};
