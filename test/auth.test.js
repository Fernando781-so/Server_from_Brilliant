const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { io, pool, server } = require('../server');

test('solo permite un inicio de sesión hasta que se cierre la sesión activa', async () => {
  const account = {
    id: 1,
    username: 'ana',
    password: await bcrypt.hash('secreto', 4),
    active_session_id: null,
  };

  pool.query = async (query, values = []) => {
    if (query.includes('information_schema.columns')) {
      return { rows: [{ column_name: 'username' }], rowCount: 1 };
    }
    if (query.includes('SELECT id, username, password FROM users')) {
      return {
        rows: account.username === values[0] ? [account] : [],
        rowCount: account.username === values[0] ? 1 : 0,
      };
    }
    if (
      query.includes(
        'SELECT id, username, password, active_session_id FROM users',
      )
    ) {
      return {
        rows: account.username === values[0] ? [account] : [],
        rowCount: account.username === values[0] ? 1 : 0,
      };
    }
    if (query.includes('UPDATE users SET active_session_id = NULL')) {
      if (
        account.id === values[0] &&
        account.active_session_id === values[1]
      ) {
        account.active_session_id = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      query.includes('UPDATE users') &&
      query.includes('active_session_id = $3')
    ) {
      if (
        account.id === values[0] &&
        account.active_session_id === values[1]
      ) {
        account.active_session_id = values[2];
        return { rows: [{ id: account.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      query.includes('UPDATE users') &&
      query.includes('active_session_id = $2')
    ) {
      if (account.active_session_id !== null) {
        return { rows: [], rowCount: 0 };
      }
      account.active_session_id = values[1];
      return { rows: [{ id: account.id }], rowCount: 1 };
    }
    if (query.includes('SELECT id FROM users WHERE id = $1 AND active_session_id = $2')) {
      return account.id === values[0] &&
          account.active_session_id === values[1]
        ? { rows: [{ id: account.id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api`;
  const request = (path, options) => fetch(`${url}${path}`, options);
  const login = () =>
    request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: 'secreto' }),
    });

  try {
    const firstLogin = await login();
    assert.equal(firstLogin.status, 200);
    const { token } = await firstLogin.json();

    const secondLogin = await login();
    assert.equal(secondLogin.status, 409);
    assert.equal((await secondLogin.json()).code, 'SESSION_ACTIVE');

    const invalidRecovery = await request('/login/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: account.username,
        password: 'incorrecta',
      }),
    });
    assert.equal(invalidRecovery.status, 401);

    const recovery = await request('/login/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: 'secreto' }),
    });
    assert.equal(recovery.status, 200);
    const { token: recoveredToken } = await recovery.json();

    const oldSession = await request('/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(oldSession.status, 401);
    const recoveredSession = await request('/session', {
      headers: { Authorization: `Bearer ${recoveredToken}` },
    });
    assert.equal(recoveredSession.status, 200);

    const concurrentLogin = await login();
    assert.equal(concurrentLogin.status, 409);

    const logout = await request('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${recoveredToken}` },
    });
    assert.equal(logout.status, 200);

    const unnecessaryRecovery = await request('/login/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: 'secreto' }),
    });
    assert.equal(unnecessaryRecovery.status, 409);

    const nextLogin = await login();
    assert.equal(nextLogin.status, 200);
  } finally {
    await new Promise((resolve) => io.close(resolve));
  }
});
