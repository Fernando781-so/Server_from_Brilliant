const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'test-only-secret';
process.env.DISCONNECT_GRACE_PERIOD_MS = '100';
const jwt = require('jsonwebtoken');
const { io: connectSocket } = require('socket.io-client');
const {
  DEFAULT_DISCONNECT_GRACE_PERIOD_MS,
  DISCONNECT_GRACE_PERIOD_MS,
  getTargetPoints,
  getZoneAward,
  getRankedLevel,
  getEloKFactor,
  calculateMultiplayerEloDeltas,
  calculateRankedDelta,
} = require('../server');
const { io, pool, server } = require('../server');

pool.query = async (query, values = []) => {
  if (query.includes('information_schema.columns')) {
    return { rows: [{ column_name: 'username' }] };
  }
  if (query.includes('active_session_id = $2')) {
    return { rows: [{ id: values[0] }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

test('configura el objetivo según la cantidad de jugadores', () => {
  assert.equal(getTargetPoints(2), 26);
  assert.equal(getTargetPoints(3), 24);
  assert.equal(getTargetPoints(4), 22);
  assert.equal(getTargetPoints(5), 21);
  assert.equal(getTargetPoints(6), 20);
  assert.throws(() => getTargetPoints(1), RangeError);
});

test('mantiene el puntaje mínimo de una zona luego de agotarse su bolsa', () => {
  const pointValues = [8, 6, 4];
  assert.equal(getZoneAward(pointValues, 0), 8);
  assert.equal(getZoneAward(pointValues, 1), 6);
  assert.equal(getZoneAward(pointValues, 2), 4);
  assert.equal(getZoneAward(pointValues, 3), 4);
  assert.equal(getZoneAward([8, 6, 4], 0), 8);
  assert.equal(getZoneAward([8, 6, 4], 1), 6);
  assert.equal(getZoneAward([8, 6, 4], 2), 4);
});

test('usa cinco minutos de gracia por defecto y permite reducirlo en pruebas', () => {
  assert.equal(DEFAULT_DISCONNECT_GRACE_PERIOD_MS, 5 * 60 * 1000);
  assert.equal(DISCONNECT_GRACE_PERIOD_MS, 100);
});

test('calcula niveles y sistema ELO multijugador en modo ranked clasificatoria', () => {
  assert.equal(getRankedLevel(999), 'Principiante');
  assert.equal(getRankedLevel(1000), 'Nuevo héroe');
  assert.equal(getRankedLevel(1150), 'Experto');
  assert.equal(getRankedLevel(1300), 'Megamente');
  assert.equal(getRankedLevel(1500), 'EL Brilliant');

  // K dinámico: 40 primeras 10 partidas, 32 normal, 24 en EL Brilliant
  assert.equal(getEloKFactor(1000, 0), 40);
  assert.equal(getEloKFactor(1000, 10), 32);
  assert.equal(getEloKFactor(1500, 10), 24);

  // Duelo 2 jugadores iguales (1000 vs 1000, K=40): ganador +20, perdedor -20
  const duel = calculateMultiplayerEloDeltas([
    { id: 'a', score: 30, rankedPoints: 1000, rankedGames: 0 },
    { id: 'b', score: 18, rankedPoints: 1000, rankedGames: 0 },
  ]);
  assert.equal(duel.get('a'), 20);
  assert.equal(duel.get('b'), -20);

  // 3 jugadores FFA (normalizado por N-1 = 2): 1º (1000) vence a 2º (1200) y 3º (1400)
  const ffa = calculateMultiplayerEloDeltas([
    { id: 'a', score: 40, rankedPoints: 1000, rankedGames: 15 },
    { id: 'b', score: 30, rankedPoints: 1200, rankedGames: 15 },
    { id: 'c', score: 20, rankedPoints: 1400, rankedGames: 15 },
  ]);
  assert.ok(ffa.get('a') > 20);
  assert.ok(ffa.get('c') < -20);

  // Piso mínimo de 100 ELO
  const floorTest = calculateMultiplayerEloDeltas([
    { id: 'low', score: 5, rankedPoints: 105, rankedGames: 0 },
    { id: 'mid', score: 25, rankedPoints: 1000, rankedGames: 0 },
  ]);
  assert.ok(105 + floorTest.get('low') >= 100);
});

test('espera la configuración inicial, reconexión y turnos de todos', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const players = [
    { id: 'player-1', username: 'Ana' },
    { id: 'player-2', username: 'Luis' },
    { id: 'player-3', username: 'Marta' },
  ];
  const sockets = players.map((player) =>
    connectSocket(url, {
      auth: {
        token: jwt.sign(
          { ...player, sessionId: `session-${player.id}` },
          'test-only-secret',
          { expiresIn: '1h' },
        ),
      },
      transports: ['websocket'],
      reconnection: false,
    }),
  );

  const waitFor = (socket, event) =>
    new Promise((resolve) => socket.once(event, resolve));
  const waitForTurn = (socket, turn) =>
    new Promise((resolve) => {
      const handleState = (state) => {
        if (state.turn !== turn) return;
        socket.off('game:state', handleState);
        resolve(state);
      };
      socket.on('game:state', handleState);
    });
  const waitForGamePhase = (socket, phase) =>
    new Promise((resolve) => {
      const handleState = (state) => {
        if (state.phase !== phase) return;
        socket.off('game:state', handleState);
        resolve(state);
      };
      socket.on('game:state', handleState);
    });
  const waitForFinishedGame = (socket) =>
    new Promise((resolve) => {
      const handleState = (state) => {
        if (state.room.status !== 'finished') return;
        socket.off('game:state', handleState);
        resolve(state);
      };
      socket.on('game:state', handleState);
    });
  const emit = (socket, event, payload) =>
    new Promise((resolve, reject) => {
      socket.emit(event, payload, (response) => {
        if (response.ok) resolve(response);
        else reject(new Error(response.error));
      });
    });

  try {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
          }),
      ),
    );

    const invalidSocket = connectSocket(url, {
      auth: { token: 'token-invalido' },
      transports: ['websocket'],
      reconnection: false,
    });
    const invalidConnection = new Promise((resolve, reject) => {
      invalidSocket.once('connect_error', resolve);
      invalidSocket.once('connect', () =>
        reject(new Error('El servidor aceptó un token inválido.')),
      );
    });
    const authenticationError = await invalidConnection;
    assert.match(authenticationError.message, /Sesión inválida o expirada/);
    invalidSocket.disconnect();

    const pointValues = [[8, 6, 4]];
    const waitingRoom = await emit(sockets[0], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: pointValues,
    });
    const joinedWaitingRoom = waitFor(sockets[0], 'lobby:update');
    await emit(sockets[2], 'lobby:join', { code: waitingRoom.room.code });
    assert.equal(
      (await joinedWaitingRoom).players.some(
        (player) => player.id === 'player-3',
      ),
      true,
    );

    const playerRemovedFromWaitingRoom = new Promise((resolve) => {
      const handleUpdate = (room) => {
        if (room.players.some((player) => player.id === 'player-3')) return;
        sockets[0].off('lobby:update', handleUpdate);
        resolve(room);
      };
      sockets[0].on('lobby:update', handleUpdate);
    });
    sockets[2].disconnect();
    const updatedWaitingRoom = await playerRemovedFromWaitingRoom;
    assert.deepEqual(
      updatedWaitingRoom.players.map((player) => player.id),
      ['player-1'],
    );

    const reconnectedWaitingPlayer = connectSocket(url, {
      auth: {
        token: jwt.sign(
          { ...players[2], sessionId: 'session-player-3' },
          'test-only-secret',
          { expiresIn: '1h' },
        ),
      },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets[2] = reconnectedWaitingPlayer;
    await new Promise((resolve, reject) => {
      reconnectedWaitingPlayer.once('connect', resolve);
      reconnectedWaitingPlayer.once('connect_error', reject);
    });
    const newWaitingRoom = await emit(sockets[2], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: pointValues,
    });
    assert.equal(newWaitingRoom.room.players[0].id, 'player-3');
    await emit(sockets[2], 'lobby:leave', {});
    await emit(sockets[0], 'lobby:leave', {});

    const created = await emit(sockets[0], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: pointValues,
    });
    await emit(sockets[1], 'lobby:join', { code: created.room.code });
    await assert.rejects(
      emit(sockets[2], 'lobby:join', { code: created.room.code }),
      /La sala está llena/,
    );
    await assert.rejects(
      emit(sockets[2], 'lobby:create', {
        capacity: 7,
        boardId: 1,
        zonePointValues: pointValues,
      }),
      /entre 2 y 6 jugadores/,
    );

    const updatedRoomForPlayerTwo = waitFor(sockets[1], 'lobby:update');
    const updatedRoom = await emit(sockets[0], 'lobby:board', {
      boardId: 2,
      zonePointValues: [[5, 3]],
    });
    assert.equal(updatedRoom.room.boardId, 2);
    assert.equal((await updatedRoomForPlayerTwo).boardId, 2);
    await assert.rejects(
      emit(sockets[1], 'lobby:board', {
        boardId: 3,
        zonePointValues: [[4, 2]],
      }),
      /Solo el anfitrión puede cambiar el tablero/,
    );
    const readyRoomForPlayerTwo = waitFor(sockets[1], 'lobby:update');
    await emit(sockets[0], 'lobby:ready', { ready: true });
    await readyRoomForPlayerTwo;
    const changedRoomForPlayerTwo = waitFor(sockets[1], 'lobby:update');
    const changedRoom = await emit(sockets[0], 'lobby:board', {
      boardId: 3,
      zonePointValues: [[6, 4]],
    });
    assert.equal(changedRoom.room.boardId, 3);
    assert.ok(changedRoom.room.players.every((player) => !player.ready));
    assert.equal((await changedRoomForPlayerTwo).boardId, 3);

    let startEvents = 0;
    for (const socket of sockets) {
      socket.on('game:start', () => {
        startEvents += 1;
      });
    }
    const playerOneStarted = waitFor(sockets[0], 'game:start');
    const playerTwoStarted = waitFor(sockets[1], 'game:start');
    await emit(sockets[0], 'lobby:ready', { ready: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(startEvents, 0);
    await emit(sockets[1], 'lobby:ready', { ready: true });

    const [firstGame, secondGame] = await Promise.all([
      playerOneStarted,
      playerTwoStarted,
    ]);
    assert.deepEqual(firstGame.dice, secondGame.dice);
    assert.equal(firstGame.turn, 1);
    assert.equal(firstGame.phase, 'setup');
    assert.deepEqual(firstGame.setupCompletePlayerIds, []);
    assert.ok(
      firstGame.room.players.every((player) => !player.setupComplete),
    );

    const setupBoard = Array(49).fill(0);
    for (let number = 1; number <= 6; number += 1) {
      setupBoard[number - 1] = number;
    }
    const invalidSetupBoard = [...setupBoard];
    invalidSetupBoard[5] = 5;
    await assert.rejects(
      emit(sockets[0], 'game:setup-complete', {
        board: invalidSetupBoard,
      }),
      /Debes colocar una vez cada número del 1 al 6/,
    );
    await assert.rejects(
      emit(sockets[0], 'game:turn-complete', {
        board: setupBoard,
        completedZones: [],
        finished: false,
      }),
      /Espera a que todos configuren su tablero inicial/,
    );

    const setupStateForOne = waitFor(sockets[0], 'game:state');
    await emit(sockets[0], 'game:setup-complete', { board: setupBoard });
    const firstSetupState = await setupStateForOne;
    assert.equal(firstSetupState.phase, 'setup');
    assert.deepEqual(firstSetupState.setupCompletePlayerIds, ['player-1']);
    assert.equal(
      firstSetupState.room.players.find((player) => player.id === 'player-1')
        .setupComplete,
      true,
    );
    assert.equal(
      firstSetupState.room.players.find((player) => player.id === 'player-2')
        .setupComplete,
      false,
    );

    const disconnectedStateForOne = waitFor(sockets[0], 'game:state');
    sockets[1].disconnect();
    const disconnectedState = await disconnectedStateForOne;
    assert.equal(disconnectedState.phase, 'setup');
    assert.equal(
      disconnectedState.room.players.find((player) => player.id === 'player-2')
        .connected,
      false,
    );
    assert.deepEqual(disconnectedState.setupCompletePlayerIds, ['player-1']);

    const reconnectedSocket = connectSocket(url, {
      auth: {
        token: jwt.sign(players[1], 'test-only-secret', { expiresIn: '1h' }),
      },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets[1] = reconnectedSocket;
    await new Promise((resolve, reject) => {
      reconnectedSocket.once('connect', resolve);
      reconnectedSocket.once('connect_error', reject);
    });
    const restoredGameState = waitFor(reconnectedSocket, 'game:state');
    await emit(reconnectedSocket, 'lobby:join', { code: created.room.code });
    const restoredGame = await restoredGameState;
    assert.equal(restoredGame.phase, 'setup');
    assert.equal(
      restoredGame.room.players.find((player) => player.id === 'player-2')
        .connected,
      true,
    );
    assert.deepEqual(restoredGame.ownBoard, null);

    const setupStateForBoth = [
      waitForGamePhase(sockets[0], 'playing'),
      waitForGamePhase(sockets[1], 'playing'),
    ];
    await emit(sockets[1], 'game:setup-complete', { board: setupBoard });
    const [readyStateOne, readyStateTwo] = await Promise.all(setupStateForBoth);
    for (const readyState of [readyStateOne, readyStateTwo]) {
      assert.equal(readyState.phase, 'playing');
      assert.deepEqual(readyState.setupCompletePlayerIds, [
        'player-1',
        'player-2',
      ]);
      assert.ok(readyState.room.players.every((player) => player.setupComplete));
    }

    const board = Array(49).fill(0);
    await assert.rejects(
      emit(sockets[0], 'game:turn-complete', {
        board: Array(48).fill(0),
        completedZones: [0],
        finished: false,
      }),
      /estado del tablero no es válido/,
    );
    await assert.rejects(
      emit(sockets[2], 'game:turn-complete', {
        board,
        completedZones: [],
        finished: false,
      }),
      /No estás en una sala activa/,
    );
    const firstTurnForOne = waitFor(sockets[0], 'game:state');
    await emit(sockets[0], 'game:turn-complete', {
      board,
      completedZones: [0],
      finished: false,
    });
    const firstState = await firstTurnForOne;
    assert.equal(firstState.turn, 1);
    assert.equal(firstState.playerBoards, undefined);
    assert.equal(
      firstState.room.players.find((player) => player.id === 'player-1').score,
      6,
    );
    await assert.rejects(
      emit(sockets[0], 'game:turn-complete', {
        board,
        completedZones: [0],
        finished: false,
      }),
      /Ya completaste este turno/,
    );

    const nextTurnForOne = waitForTurn(sockets[0], 2);
    const nextTurnForTwo = waitForTurn(sockets[1], 2);
    await emit(sockets[1], 'game:turn-complete', {
      board,
      completedZones: [0],
      finished: false,
    });
    const [secondState, secondStateForTwo] = await Promise.all([
      nextTurnForOne,
      nextTurnForTwo,
    ]);
    assert.equal(secondState.turn, 2);
    assert.deepEqual(secondState.dice, secondStateForTwo.dice);
    assert.deepEqual(secondState.zoneClaims['0'].map((claim) => claim.points), [
      6,
      4,
    ]);
    assert.deepEqual(
      secondState.zoneClaims['0'].map((claim) => claim.username),
      ['Ana', 'Luis'],
    );

    const turnAfterDisconnect = waitForTurn(sockets[0], 3);
    const finishedGameForOne = waitForFinishedGame(sockets[0]);
    const disconnectStartedAt = Date.now();
    await emit(sockets[0], 'game:turn-complete', {
      board,
      completedZones: [0],
      finished: false,
    });
    sockets[1].disconnect();
    const thirdState = await turnAfterDisconnect;
    assert.equal(thirdState.turn, 3);
    assert.deepEqual(thirdState.completedPlayerIds, []);
    assert.deepEqual(thirdState.zoneClaims['0'].map((claim) => claim.points), [
      6,
      4,
    ]);
    assert.deepEqual(
      thirdState.room.players.map((player) => player.score),
      [6, 4],
    );
    const finishedGame = await finishedGameForOne;
    assert.ok(Date.now() - disconnectStartedAt >= DISCONNECT_GRACE_PERIOD_MS);
    assert.equal(finishedGame.room.status, 'finished');
    assert.equal(finishedGame.winnerId, 'player-1');
    assert.deepEqual(finishedGame.playerBoards, {
      'player-1': board,
      'player-2': board,
    });
    assert.equal(
      finishedGame.room.players.find((player) => player.id === 'player-2')
        .finished,
      true,
    );

    // Prueba de salida de partida en ejecución / en espera y creación inmediata de nueva sala clasificatoria sin error
    const rankedRoomOne = await emit(sockets[0], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: [[30, 20, 10]],
      ranked: true,
      rankedPoints: 100,
    });
    assert.equal(rankedRoomOne.room.ranked, true);
    assert.equal(rankedRoomOne.room.players[0].rankedPoints, 100);
    assert.equal(rankedRoomOne.room.players[0].rankedLevel, 'Principiante');

    // Al salir de la sala en espera y crear otra de inmediato no marca error en el primer intento
    await emit(sockets[0], 'lobby:leave', {});
    const rankedRoomTwo = await emit(sockets[0], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: [[30, 20, 10]],
      ranked: true,
      rankedPoints: 950,
    });
    assert.equal(rankedRoomTwo.room.ranked, true);

    await emit(sockets[2], 'lobby:join', {
      code: rankedRoomTwo.room.code,
      rankedPoints: 1100,
    });
    const rankedStarted = [
      waitFor(sockets[0], 'game:start'),
      waitFor(sockets[2], 'game:start'),
    ];
    await emit(sockets[0], 'lobby:ready', { ready: true });
    await emit(sockets[2], 'lobby:ready', { ready: true });
    const [rankedStartState] = await Promise.all(rankedStarted);
    assert.equal(
      rankedStartState.room.players.find((p) => p.id === 'player-3').rankedLevel,
      'Nuevo héroe',
    );

    // Si un jugador se sale de la partida en ejecución y crea otra sala de inmediato, funciona al primer intento
    await emit(sockets[2], 'lobby:leave', {});
    const roomAfterLeavingRunningGame = await emit(sockets[2], 'lobby:create', {
      capacity: 2,
      boardId: 1,
      zonePointValues: [[30, 20, 10]],
      ranked: true,
      rankedPoints: 1200,
    });
    assert.equal(roomAfterLeavingRunningGame.room.hostId, 'player-3');

    // Ahora player-1 (1000 ELO, Nuevo héroe) se une a la sala de player-3 (1200 ELO, Experto) y le gana
    await emit(sockets[0], 'lobby:leave', {});
    await emit(sockets[0], 'lobby:join', {
      code: roomAfterLeavingRunningGame.room.code,
      rankedPoints: 1000,
    });
    await emit(sockets[2], 'lobby:ready', { ready: true });
    await emit(sockets[0], 'lobby:ready', { ready: true });
    await emit(sockets[2], 'game:setup-complete', { board: setupBoard });
    await emit(sockets[0], 'game:setup-complete', { board: setupBoard });

    // player-1 (1000 ELO, K=40) vence a player-3 (1200 ELO): esperado ~0.2403 -> +30 ELO (1000 -> 1030)
    const rankedFinishResult = await emit(sockets[0], 'game:turn-complete', {
      board,
      completedZones: [0],
      finished: true,
    });
    const winnerRankedPlayer = rankedFinishResult.state.room.players.find(
      (p) => p.id === 'player-1',
    );
    const loserRankedPlayer = rankedFinishResult.state.room.players.find(
      (p) => p.id === 'player-3',
    );
    assert.equal(winnerRankedPlayer.rankedDelta, 30);
    assert.equal(winnerRankedPlayer.rankedPoints, 1030);
    assert.equal(loserRankedPlayer.rankedDelta, -30);
    assert.equal(loserRankedPlayer.rankedPoints, 1170);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
  }
});
