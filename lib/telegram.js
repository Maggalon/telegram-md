import crypto from 'node:crypto';

const API = 'https://api.telegram.org';

export function botToken() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  return token;
}

/** Вызов метода Bot API. Возвращает распарсенный JSON-ответ Telegram ({ ok, result | description }). */
export async function tg(method, params = {}) {
  const res = await fetch(`${API}/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

/** Вызов метода с multipart/form-data (для загрузки файлов). */
export async function tgMultipart(method, form) {
  const res = await fetch(`${API}/bot${botToken()}/${method}`, { method: 'POST', body: form });
  return res.json();
}

/** Публичный адрес приложения (без завершающего слэша). */
export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Секрет для заголовка X-Telegram-Bot-Api-Secret-Token, выводится из токена бота. */
export function webhookSecret() {
  return hmac(botToken(), 'webhook-secret').toString('hex');
}

/** Персональный токен для входа в веб-приложение из обычного браузера: "<userId>.<подпись>". */
export function makeLinkToken(userId) {
  const sig = hmac(botToken(), `link:${userId}`).toString('base64url').slice(0, 32);
  return `${userId}.${sig}`;
}

function verifyLinkToken(token) {
  const m = /^(\d+)\.([\w-]+)$/.exec(token || '');
  if (!m) return null;
  return safeEqual(makeLinkToken(m[1]), token) ? { id: Number(m[1]) } : null;
}

/** Проверка initData из Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
function verifyInitData(initData, maxAgeSec = 24 * 3600) {
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = hmac('WebAppData', botToken());
  if (!safeEqual(hmac(secret, checkString).toString('hex'), hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/** Определяет пользователя по { initData } (Mini App) или { token } (ссылка из бота). */
export function authenticate({ initData, token } = {}) {
  return (initData && verifyInitData(initData)) || (token && verifyLinkToken(token)) || null;
}

/** Если задан ALLOWED_USERS (id через запятую), пускаем только этих пользователей. */
export function isAllowed(userId) {
  const list = (process.env.ALLOWED_USERS || '').split(/[\s,]+/).filter(Boolean);
  return list.length === 0 || list.includes(String(userId));
}

export function botId() {
  return Number(botToken().split(':')[0]);
}

const ADMIN = new Set(['creator', 'administrator']);

/**
 * Проверяет, что пользователь может публиковать через бота в чат chatRef (@username или числовой id):
 * в канале пользователь должен быть админом, в группе — участником; бот должен иметь право писать.
 * Возвращает { ok: true, chat } или { ok: false, error }.
 */
export async function resolveDestination(userId, chatRef) {
  const ref = String(chatRef || '').trim().replace(/^https?:\/\/t\.me\//i, '@');
  if (!/^(@\w{4,}|-?\d+)$/.test(ref)) return { ok: false, error: 'Укажите @username канала или числовой id чата.' };

  const chatRes = await tg('getChat', { chat_id: ref });
  if (!chatRes.ok) return { ok: false, error: 'Бот не видит этот чат. Сначала добавьте бота в канал или группу.' };
  const chat = chatRes.result;
  if (chat.type === 'private') return { ok: false, error: 'Это личный чат, а не канал или группа.' };

  const [me, bot] = await Promise.all([
    tg('getChatMember', { chat_id: chat.id, user_id: userId }),
    tg('getChatMember', { chat_id: chat.id, user_id: botId() }),
  ]);
  const isChannel = chat.type === 'channel';

  const u = me.result;
  const userOk = me.ok && (isChannel
    ? u.status === 'creator' || (u.status === 'administrator' && u.can_post_messages)
    : ADMIN.has(u.status) || u.status === 'member' || (u.status === 'restricted' && u.is_member));
  if (!userOk) {
    return { ok: false, error: isChannel ? 'Вы не администратор этого канала с правом публикации.' : 'Вы не состоите в этой группе.' };
  }

  const b = bot.result;
  const botOk = bot.ok && (isChannel
    ? b.status === 'administrator' && b.can_post_messages
    : ADMIN.has(b.status) || b.status === 'member' || (b.status === 'restricted' && b.can_send_messages));
  if (!botOk) {
    return { ok: false, error: isChannel ? 'Сделайте бота администратором канала с правом «Публикация сообщений».' : 'Бот не может писать в эту группу.' };
  }

  return { ok: true, chat: { id: chat.id, title: chat.title, type: chat.type, username: chat.username || null } };
}
