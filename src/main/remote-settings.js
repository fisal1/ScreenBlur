function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validateRemoteEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Enter a valid WebSocket endpoint');
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Enter a valid WebSocket endpoint');
  }
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/v1/inference/stream'
  ) {
    throw new Error('Use ws(s)://host:port/v1/inference/stream without credentials or query parameters');
  }
  if (endpoint.protocol === 'ws:' && !isLoopback(endpoint.hostname)) {
    throw new Error('Remote endpoints must use wss://; unencrypted ws:// is allowed only on this device');
  }
  return endpoint.href;
}

module.exports = { validateRemoteEndpoint };
