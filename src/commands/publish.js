'use strict';

// Thin wrapper – delegates to builds.publish
const builds = require('./builds');

async function run() {
  await builds.publish();
}

module.exports = { run };
