import { tg, tgMultipart, authenticate, isAllowed, resolveDestination } from '../lib/telegram.js';

const MEDIA_TYPES = new Set(['photo', 'video', 'animation', 'audio', 'voice_note', 'document']);
const MAX_TEXT = 32768;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const user = authenticate(body.auth);
  if (!user) {
    res.status(401).json({ ok: false, error: 'Не удалось подтвердить пользователя. Откройте редактор заново из бота.' });
    return;
  }
  if (!isAllowed(user.id)) {
    res.status(403).json({ ok: false, error: 'Доступ к боту закрыт.' });
    return;
  }

  const format = body.format === 'html' ? 'html' : 'markdown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    res.status(400).json({ ok: false, error: 'Пустой пост.' });
    return;
  }
  if ([...text].length > MAX_TEXT) {
    res.status(400).json({ ok: false, error: `Пост длиннее ${MAX_TEXT} символов.` });
    return;
  }

  const richMessage = { [format]: text };
  if (body.skipEntityDetection) richMessage.skip_entity_detection = true;
  if (body.rtl) richMessage.is_rtl = true;

  // Файлы, загруженные в редакторе, приходят в base64 и подключаются через tg://<type>?id=<id>.
  const files = Array.isArray(body.files) ? body.files.filter((f) => text.includes(`?id=${f.id}`)) : [];
  for (const f of files) {
    if (!/^[\w-]{1,64}$/.test(f.id || '') || !MEDIA_TYPES.has(f.kind) || typeof f.data !== 'string') {
      res.status(400).json({ ok: false, error: `Некорректный файл: ${f.name || f.id}` });
      return;
    }
  }

  // По умолчанию — в личку. Для канала/группы права проверяются при каждой отправке.
  let chatId = user.id;
  if (body.chatId != null && String(body.chatId) !== String(user.id)) {
    try {
      const dest = await resolveDestination(user.id, body.chatId);
      if (!dest.ok) {
        res.status(403).json({ ok: false, error: dest.error });
        return;
      }
      chatId = dest.chat.id;
    } catch (err) {
      console.error('destination error', err);
      res.status(502).json({ ok: false, error: 'Не удалось связаться с Telegram.' });
      return;
    }
  }

  const params = {
    chat_id: chatId,
    disable_notification: Boolean(body.silent),
  };

  let result;
  try {
    if (files.length === 0) {
      result = await tg('sendRichMessage', { ...params, rich_message: richMessage });
    } else {
      richMessage.media = files.map((f) => ({
        id: f.id,
        media: { type: f.kind, media: `attach://${f.id}` },
      }));
      const form = new FormData();
      form.append('chat_id', String(params.chat_id));
      form.append('disable_notification', String(params.disable_notification));
      form.append('rich_message', JSON.stringify(richMessage));
      for (const f of files) {
        const blob = new Blob([Buffer.from(f.data, 'base64')], { type: f.mime || 'application/octet-stream' });
        form.append(f.id, blob, f.name || f.id);
      }
      result = await tgMultipart('sendRichMessage', form);
    }
  } catch (err) {
    console.error('send error', err);
    res.status(502).json({ ok: false, error: 'Не удалось связаться с Telegram.' });
    return;
  }

  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.description || 'Telegram вернул ошибку.' });
    return;
  }
  res.status(200).json({ ok: true, messageId: result.result?.message_id });
}
