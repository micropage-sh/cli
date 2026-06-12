#!/usr/bin/env node

// Suppress Node's "buffer.File is an experimental feature" warning that fires
// when undici's FormData serializes a Blob upload. Stabilized in Node 22.
const origEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    /buffer\.File/.test(String(data.message))
  ) {
    return false;
  }
  return origEmit.call(this, name, data, ...rest);
};

require('../src/index.js');
