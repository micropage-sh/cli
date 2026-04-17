'use strict';

const { clearSession, getSession } = require('../auth');

function run() {
  const session = getSession();
  if (!session) {
    console.log('Not currently logged in.');
    return;
  }
  clearSession();
  const email = session.user?.email || 'unknown';
  console.log(`Logged out (was: ${email}).`);
}

module.exports = { run };
