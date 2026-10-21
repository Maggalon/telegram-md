import { tg, appUrl, webhookSecret, makeLinkToken, isAllowed } from '../lib/telegram.js';

const HELP = [
  '<b>Как пользоваться</b>',
  '',
  '1. Откройте редактор кнопкой ниже (или кнопкой меню рядом с полем ввода).',
  '2. Напишите пост в Markdown или HTML — заголовки, таблицы, списки, цитаты, спойлеры, формулы, медиа.',
  '3. Нажмите «Отправить в Telegram» — бот пришлёт готовый пост сюда.',
  '4. Перешлите пост куда нужно: в канал, группу или другому человеку.',
  '',
  'Команды:',
  '/start — открыть редактор',
  '/link — личная ссылка на редактор для обычного браузера',
].join('\n');

function keyboard(req, userId) {
  const url = appUrl(req);
  return {
    inline_keyboard: [
      [{ text: '✍️ Открыть редактор', web_app: { url } }],
      [{ text: '🌐 Открыть в браузере', url: `${url}/#token=${makeLinkToken(userId)}` }],
    ],
  };
}

async function handleMessage(req, msg) {
  if (msg.chat?.type !== 'private' || !msg.from) return;
  const chatId = msg.chat.id;

  if (!isAllowed(msg.from.id)) {
    await tg('sendMessage', { chat_id: chatId, text: `Доступ к боту закрыт. Ваш id: ${msg.from.id}` });
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
  } catch (err) {
    console.error('webhook error', err);
  }
  // Всегда 200, иначе Telegram будет повторять доставку апдейта.
  res.status(200).json({ ok: true });
}
