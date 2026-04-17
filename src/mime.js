'use strict';

const MAP = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function fromFilename(filename) {
  const ext = require('path').extname(filename).toLowerCase();
  return MAP[ext] || 'application/octet-stream';
}

module.exports = { fromFilename };
