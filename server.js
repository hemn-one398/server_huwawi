import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await loadEnv(join(root, '.env'));

const agc = await loadAgconnect(join(root, '..', 'android', 'app', 'agconnect-services.json'));
const appId = agc.appId || (process.env.HUAWEI_APP_ID ?? '').trim();
const appKey = agc.appKey || (process.env.HUAWEI_APP_KEY ?? '').trim();
const packageName = agc.packageName;
const clientSecret = (process.env.HUAWEI_CLIENT_SECRET ?? '').trim();
const oauthUrl =
  (process.env.HUAWEI_OAUTH_URL ?? '').trim() ||
  'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const pushUrl = (
  (process.env.HUAWEI_PUSH_URL ?? '').trim() || 'https://push-api.cloud.huawei.com'
).replace(/\/+$/, '');
const defaultDeviceToken = (process.env.DEFAULT_DEVICE_TOKEN ?? '').trim();
const port = Number(process.env.PORT) || 3000;
const configured = appId.length > 0 && clientSecret.length > 0 && appKey.length > 0;

let cachedToken = null;

const indexHtml = await readFile(join(root, 'public', 'index.html'));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, indexHtml, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, {
        appId,
        packageName,
        appKeySet: appKey.length > 0,
        configured,
        defaultDeviceToken,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const result = await handleSend(req);
      sendJson(res, result.httpStatus, result.body);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: 'Server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Huawei push dashboard at http://localhost:${port}`);
});

async function handleSend(req) {
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    return { httpStatus: 400, body: { ok: false, error: 'Invalid JSON' } };
  }
  if (!input || typeof input !== 'object') {
    return { httpStatus: 400, body: { ok: false, error: 'Invalid JSON' } };
  }

  const kind = input.kind === 'call' ? 'call' : input.kind === 'message' ? 'message' : '';
  const token = text(input.token);
  const validateOnly = input.validateOnly === true;

  if (!kind) {
    return { httpStatus: 400, body: { ok: false, error: 'Choose message or call' } };
  }

  const built = kind === 'call' ? buildCallData(input) : buildMessageData(input);
  if (built.error) {
    return {
      httpStatus: 400,
      body: { ok: false, kind, validateOnly, error: built.error },
    };
  }
  if (!token) {
    return {
      httpStatus: 400,
      body: { ok: false, kind, validateOnly, error: 'Device token is required' },
    };
  }
  if (!configured) {
    return {
      httpStatus: 500,
      body: { ok: false, kind, validateOnly, error: 'Missing server/.env' },
    };
  }

  const data = built.data;

  const payload = {
    validate_only: validateOnly,
    message: {
      data,
      android: androidConfig(kind, built),
      token: [token],
    },
  };

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (error) {
    return {
      httpStatus: 502,
      body: {
        ok: false,
        kind,
        validateOnly,
        error: error instanceof Error ? error.message : 'OAuth failed',
      },
    };
  }

  let response;
  try {
    response = await fetch(`${pushUrl}/v1/${appId}/messages:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      httpStatus: 502,
      body: { ok: false, kind, validateOnly, error: 'Push request failed' },
    };
  }

  const json = await response.json().catch(() => ({}));
  const code = json.code == null ? '' : String(json.code);
  const msg = typeof json.msg === 'string' ? json.msg : '';
  const requestId = String(json.requestId ?? json.request_id ?? '');
  const ok = response.ok && code === '80000000';
  const result = {
    ok,
    kind,
    validateOnly,
    status: response.status,
    code,
    msg,
    requestId,
  };
  if (!ok) {
    result.error = msg || code || 'Push rejected';
  }
  return { httpStatus: 200, body: result };
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const response = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: clientSecret,
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('OAuth rejected');
  }
  const expiresIn = Number(json.expires_in);
  const lifetime = Number.isFinite(expiresIn) ? Math.max(0, expiresIn - 60) : 3540;
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + lifetime * 1000,
  };
  return cachedToken.token;
}

function buildMessageData(input) {
  const title = text(input.title);
  const body = text(input.body);
  if (!title || !body) {
    return { error: 'Title and message are required' };
  }
  const roomId = text(input.roomId);
  const roomName = text(input.roomName) || title;
  const payload = {
    type: 'message',
    title,
    body,
    message: body,
    room_id: roomId,
  };
  if (roomId) {
    payload.room = JSON.stringify({
      id: roomId,
      name: roomName,
      is_group: input.isGroup === true,
    });
  }
  return { data: JSON.stringify(payload), title, body };
}

function androidConfig(kind, built) {
  const android = { urgency: 'HIGH', category: 'IM' };
  if (kind !== 'message' || !built.title || !built.body) return android;
  android.notification = {
    title: built.title,
    body: built.body,
    channel_id: 'hakki_messages',
    importance: 'HIGH',
    foreground_show: false,
    click_action: { type: 3 },
    sound: '/raw/message_incoming',
    default_sound: false,
    use_default_vibrate: true,
    visibility: 'PUBLIC',
    auto_cancel: true,
  };
  return android;
}

function buildCallData(input) {
  const chatId = text(input.chatId);
  const callerId = text(input.callerId);
  const name = text(input.name) || text(input.title);
  if (!chatId || !callerId || !name) {
    return { error: 'Chat id, caller id, and caller name are required' };
  }
  const isVideo = input.isVideo === true;
  const userId = Number(text(input.userId));
  const title = text(input.title) || name;
  const body = text(input.body) || (isVideo ? 'Incoming video call' : 'Incoming voice call');
  return {
    data: JSON.stringify({
      type: 'call',
      title,
      body,
      chat_id: chatId,
      caller_id: callerId,
      name,
      phone: text(input.phone),
      profile: text(input.profile),
      callUUID: text(input.callUUID) || `call_${Date.now()}`,
      is_video_call: isVideo ? 'true' : 'false',
      is_group: input.isGroup === true ? 'true' : 'false',
      join_tokens: JSON.stringify([
        { user_id: Number.isFinite(userId) ? userId : 0, token: text(input.joinToken) },
      ]),
    }),
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

async function loadAgconnect(path) {
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    const client = json.client ?? {};
    return {
      appId: String(client.app_id ?? json.app_info?.app_id ?? '').trim(),
      appKey: String(client.api_key ?? '').trim(),
      packageName: String(client.package_name ?? json.app_info?.package_name ?? '').trim(),
    };
  } catch {
    return { appId: '', appKey: '', packageName: '' };
  }
}

async function loadEnv(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
