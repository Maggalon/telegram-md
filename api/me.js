import { authenticate, isAllowed } from '../lib/telegram.js';

/** Проверка авторизации: редактор показывает, кому уйдёт пост. */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const user = authenticate(req.body?.auth);
  if (!user || !isAllowed(user.id)) {
    res.status(401).json({ ok: false });
    return;
  }
  res.status(200).json({ ok: true, user: { id: user.id, first_name: user.first_name, username: user.username } });
}
