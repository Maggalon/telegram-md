import { tg, appUrl, webhookSecret, makeLinkToken, isAllowed } from '../lib/telegram.js';

const HELP = [
  '<b>Как пользоваться</b>',
  '',
  '1. Откройте редактор кнопкой ниже (или кнопкой меню рядом с полем ввода).',
  '2. Напишите пост в Markdown или HTML — заголовки, таблицы, списки, цитаты, спойлеры, формулы, медиа.',
  '3. Нажмите «Отправить в Telegram» — бот пришлёт готовый пост сюда.',
  '4. Перешлите пост куда нужно: в канал, группу или другому человеку.',
  '',
  '<b>Публикация прямо в канал</b>',
  'Добавьте бота администратором канала с правом «Публикация сообщений» (или участником группы) и выберите канал в поле «Куда» в редакторе. Пост выйдет от имени канала, без пометки о боте.',
  'Для приватного канала перешлите сюда любой пост из него — бот подскажет id.',
  '',
  'Команды:',
  '/start — открыть редактор',
  '/link — личная ссылка на редактор для обычного браузера',
].join('\n');

/** Клавиатура с редактором; если передан addChat, редактор сразу добавит этот чат в список «Куда». */
function keyboard(req, userId, addChat) {
  const url = appUrl(req);
  const q = addChat ? `add_chat=${encodeURIComponent(addChat)}` : '';
  return {
    inline_keyboard: [
      [{ text: addChat ? '✍️ Писать в этот чат' : '✍️ Открыть редактор', web_app: { url: q ? `${url}/?${q}` : url } }],
      [{ text: '🌐 Открыть в браузере', url: `${url}/#token=${makeLinkToken(userId)}${q ? '&' + q : ''}` }],
    ],
  };
}

const IN = new Set(['creator', 'administrator', 'member', 'restricted']);

/** Бота добавили в канал/группу или изменили его права — сообщаем тому, кто это сделал. */
async function handleMyChatMember(req, upd) {
  const { chat, from, new_chat_member: now, old_chat_member: before } = upd;
  if (chat.type === 'private' || !from || from.is_bot || !isAllowed(from.id)) return;
  if (!IN.has(now.status)) return;

  const title = escapeHtml(chat.title || chat.username || chat.id);
  const canPost = chat.type !== 'channel' || (now.status === 'administrator' && now.can_post_messages);
  const wasIn = IN.has(before.status);
  if (wasIn && !canPost) return;

  const text = canPost
    ? `Бот подключён к «<b>${title}</b>». Теперь посты можно публиковать туда напрямую — выберите этот чат в поле «Куда» в редакторе.`
    : `Бот добавлен в канал «<b>${title}</b>», но без права публикации. Откройте настройки администраторов канала и включите для бота «Публикация сообщений».`;
  // Если пользователь ещё не запускал бота, Telegram не даст написать ему — это нормально.
  await tg('sendMessage', {
    chat_id: from.id,
    parse_mode: 'HTML',
    text,
    reply_markup: canPost ? keyboard(req, from.id, chat.id) : undefined,
  });
}

async function handleMessage(req, msg) {
  if (msg.chat?.type !== 'private' || !msg.from) return;
  const chatId = msg.chat.id;

  if (!isAllowed(msg.from.id)) {
    await tg('sendMessage', { chat_id: chatId, text: `Доступ к боту закрыт. Ваш id: ${msg.from.id}` });
    return;
  }

  // Пересланный пост из канала — подсказываем id канала (полезно для приватных каналов без @username).
  const origin = msg.forward_origin;
  if (origin?.type === 'channel' && origin.chat) {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `Канал «<b>${escapeHtml(origin.chat.title || '')}</b>», id: <code>${origin.chat.id}</code>.\nЧтобы публиковать туда, добавьте бота администратором канала с правом «Публикация сообщений».`,
      reply_markup: keyboard(req, msg.from.id, origin.chat.id),
    });
    return;
  }

  const command = (msg.text || '').split(/[\s@]/)[0];
  switch (command) {
    case '/start':
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `Привет, ${escapeHtml(msg.from.first_name || 'друг')}! Здесь можно собрать пост с расширенной разметкой: заголовки, таблицы, списки, сноски, формулы и медиа.\n\n${HELP}`,
        reply_markup: keyboard(req, msg.from.id),
      });
      break;
    case '/link':
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: 'Ваша личная ссылка на редактор. Никому её не передавайте — по ней можно отправлять вам сообщения от имени бота.',
        reply_markup: keyboard(req, msg.from.id),
      });
      break;
    default:
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: HELP,
        reply_markup: keyboard(req, msg.from.id),
      });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('Webhook endpoint. Telegram sends POST requests here.');
    return;
  }
  if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) {
    res.status(401).send('Unauthorized');
    return;
  }
  try {
    const update = req.body || {};
    if (update.message) await handleMessage(req, update.message);
    if (update.my_chat_member) await handleMyChatMember(req, update.my_chat_member);
  } catch (err) {
    console.error('webhook error', err);
  }
  // Всегда 200, иначе Telegram будет повторять доставку апдейта.
  res.status(200).json({ ok: true });
}
