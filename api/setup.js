import { tg, appUrl, webhookSecret } from '../lib/telegram.js';

/**
 * Одноразовая настройка бота: регистрирует вебхук, команды и кнопку меню с Mini App.
 * Откройте https://<ваш-домен>/api/setup после деплоя. Повторный вызов безопасен.
 */
export default async function handler(req, res) {
  const url = appUrl(req);
  try {
    const webhook = await tg('setWebhook', {
      url: `${url}/api/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ['message', 'my_chat_member'],
      drop_pending_updates: true,
    });
    const commands = await tg('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть редактор постов' },
        { command: 'link', description: 'Ссылка на редактор для браузера' },
      ],
    });
    const menu = await tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Редактор', web_app: { url } },
    });
    const me = await tg('getMe');
    res.status(200).json({
      ok: webhook.ok && commands.ok && menu.ok,
      bot: me.result?.username ? `https://t.me/${me.result.username}` : null,
      appUrl: url,
      webhook,
      commands,
      menu,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
