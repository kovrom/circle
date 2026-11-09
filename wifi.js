// Wi-Fi management through NetworkManager's nmcli (Linux only).
const { execFile } = require('child_process');

const NMCLI_TIMEOUT_MS = 60000;
const WIFI_CONNECTION_TYPES = new Set(['802-11-wireless', 'wifi']);

// Splits a line of `nmcli -t` output, where ':' and '\' inside values are backslash-escaped.
function parseTerseLine(line) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      i++;
      current += line[i];
    } else if (char === ':') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function terseRows(stdout) {
  return stdout.split('\n').filter((line) => line.length > 0).map(parseTerseLine);
}

// Input: `nmcli -t -f NAME,TYPE connection show --active`
function parseActiveWifiName(stdout) {
  for (const [name, type] of terseRows(stdout)) {
    if (WIFI_CONNECTION_TYPES.has(type)) return name;
  }
  return null;
}

// Input: `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list`
// A network with several access points is listed once, at its strongest signal.
function parseWifiList(stdout) {
  const networks = new Map();
  for (const [inUse, ssid, signalText, security] of terseRows(stdout)) {
    if (!ssid) continue; // hidden network

    const signal = parseInt(signalText, 10) || 0;
    const connected = inUse === '*';
    const known = networks.get(ssid);
    if (known) {
      known.signal = Math.max(known.signal, signal);
      known.connected = known.connected || connected;
    } else {
      const isSecured = Boolean(security) && security !== '--';
      networks.set(ssid, { ssid, signal, security: isSecured ? 'secured' : 'open', connected });
    }
  }
  return [...networks.values()].sort((a, b) => b.signal - a.signal);
}

function nmcli(args) {
  return new Promise((resolve, reject) => {
    // LANGUAGE keeps nmcli's messages in English so friendlyConnectError can match them.
    const options = { timeout: NMCLI_TIMEOUT_MS, env: { ...process.env, LANGUAGE: 'C' } };
    execFile('nmcli', args, options, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      // error.message and error.cmd contain the full command line, including any
      // Wi-Fi password, so only stderr and the exit status may leave this function.
      let reason = (stderr || '').trim() || `nmcli exited with status ${error.code}`;
      if (error.code === 'ENOENT') reason = 'nmcli is not available on this system';
      if (error.killed) reason = 'nmcli timed out';
      reject(new Error(reason));
    });
  });
}

function friendlyConnectError(message) {
  if (message.includes('Secrets were required')) return 'Invalid password or authentication failed';
  if (message.includes('No network with SSID')) return 'Network not found';
  if (message.includes('Connection activation failed')) return 'Failed to connect - network may be out of range';
  return message;
}

async function getActiveWifiName() {
  return parseActiveWifiName(await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active']));
}

async function scanNetworks() {
  return parseWifiList(await nmcli(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']));
}

async function connect(ssid, password) {
  const args = ['dev', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  try {
    await nmcli(args);
  } catch (error) {
    throw new Error(friendlyConnectError(error.message));
  }
}

async function disconnectActive() {
  const name = await getActiveWifiName();
  if (!name) throw new Error('No active WiFi connection found');
  await nmcli(['connection', 'down', name]);
  return name;
}

module.exports = {
  connect,
  disconnectActive,
  getActiveWifiName,
  parseActiveWifiName,
  parseTerseLine,
  parseWifiList,
  scanNetworks
};
