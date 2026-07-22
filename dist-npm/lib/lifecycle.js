'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function dataHome(env = process.env) {
  return env.NEUROVAULT_HOME || env.ENGRAM_HOME || path.join(os.homedir(), '.neurovault');
}

function baseUrl(env = process.env) {
  return (env.NEUROVAULT_API_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

function markerPath(env = process.env) {
  return path.join(dataHome(env), 'managed-backend.json');
}

function isLoopbackEndpoint(env = process.env) {
  try {
    const url = new URL(baseUrl(env));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(host);
  } catch (_error) {
    return false;
  }
}

function readMarker(env = process.env) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(env), 'utf8'));
    if (
      marker.schema_version !== 1 ||
      marker.managed_by !== '@neurovault/mcp' ||
      !Number.isInteger(marker.pid) ||
      typeof marker.instance_id !== 'string'
    ) {
      return null;
    }
    return marker;
  } catch (_error) {
    return null;
  }
}

async function backendIdentity(env = process.env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${baseUrl(env)}/api/version`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const value = await response.json();
    if (
      typeof value.version !== 'string' ||
      !Number.isInteger(value.pid) ||
      typeof value.instance_id !== 'string'
    ) {
      return null;
    }
    return value;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function markerOwns(marker, identity) {
  return Boolean(
    marker &&
      identity &&
      marker.pid === identity.pid &&
      marker.instance_id === identity.instance_id,
  );
}

async function status(env = process.env) {
  const identity = await backendIdentity(env);
  if (!identity) {
    return { running: false, managed: false, endpoint: baseUrl(env) };
  }
  return {
    running: true,
    managed: isLoopbackEndpoint(env) && markerOwns(readMarker(env), identity),
    endpoint: baseUrl(env),
    ...identity,
  };
}

async function stop(env = process.env) {
  if (!isLoopbackEndpoint(env)) {
    const error = new Error(
      `refusing to stop ${baseUrl(env)} because lifecycle commands can control only an exact loopback endpoint`,
    );
    error.code = 'REMOTE_ENDPOINT';
    throw error;
  }
  const identity = await backendIdentity(env);
  if (!identity) {
    return { stopped: true, alreadyStopped: true, endpoint: baseUrl(env) };
  }
  const marker = readMarker(env);
  if (!markerOwns(marker, identity)) {
    const error = new Error(
      `the backend on ${baseUrl(env)} was not started by @neurovault/mcp; ` +
        'quit the NeuroVault desktop app or stop that manually managed process instead',
    );
    error.code = 'NOT_MANAGED';
    throw error;
  }

  process.kill(identity.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const live = await backendIdentity(env);
    if (!live || live.instance_id !== identity.instance_id) {
      try {
        fs.unlinkSync(markerPath(env));
      } catch (_error) {
        // A missing marker is already the desired end state.
      }
      return { stopped: true, alreadyStopped: false, endpoint: baseUrl(env), pid: identity.pid };
    }
  }
  throw new Error(`managed backend pid ${identity.pid} did not stop within 4 seconds`);
}

module.exports = {
  backendIdentity,
  baseUrl,
  dataHome,
  isLoopbackEndpoint,
  markerOwns,
  markerPath,
  readMarker,
  status,
  stop,
};
