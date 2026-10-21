import { authenticate, isAllowed, resolveDestination } from '../lib/telegram.js';

/** Проверка канала/группы перед добавлением в список «Куда отправить». */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const user = authenticate(req.body?.auth);
  if (!user || !isAllowed(user.id)) {
    res.status(401).json({ ok: false, error: 'Не удалось подтвердить пользователя.' });
    return;
  }
  try {
    const result = await resolveDestination(user.id, req.body?.chat);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('chats error', err);
    res.status(502).json({ ok: false, error: 'Не удалось связаться с Telegram.' });
  }
}
