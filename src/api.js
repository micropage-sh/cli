const { getToken } = require('./auth');

const BASE_URL = process.env.MICROPAGE_API_URL || 'https://api.microsite.sh';

async function request(method, path, body = null) {
  const token = getToken();
  if (!token) {
    const err = new Error('No token set. Run: micropage token set <token>');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const url = path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== null && body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = new Error(data?.error || data?.message || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  delete: (path) => request('DELETE', path),
};

module.exports = { api, BASE_URL };
