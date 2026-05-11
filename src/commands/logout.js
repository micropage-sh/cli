'use strict';

const { clearSession, getSession } = require('../auth');

function run() {
  const session = getSession();
  if (!session) {
    console.log('Not currently logged in.');
    return;
  }
  clearSession();
  const displayName = session.user?.email
    || session.user?.user_metadata?.full_name
    || session.user?.user_metadata?.user_name
    || session.user?.user_metadata?.name
    || session.user?.id;
  if (displayName) {
    console.log(`Logged out (was: ${displayName}).`);
  } else {
    console.log('Logged out.');
  }
}

module.exports = { run };
