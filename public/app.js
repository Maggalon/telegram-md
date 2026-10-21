(() => {
  'use strict';

  const MAX_CHARS = 32768;
  const MAX_UPLOAD_BYTES = 3.2 * 1024 * 1024; // лимит тела запроса Vercel — 4.5 МБ, base64 раздувает файлы на ~33%
  const DRAFT_KEY = 'rp_draft';
  const TOKEN_KEY = 'rp_token';

  const $ = (sel) => document.querySelector(sel);
  const editor = $('#editor');
  const preview = $('#preview');
  const tgApp = window.Telegram?.WebApp;

  const state = {
    format: 'markdown',
    files: [], // { id, file, kind, url }
    auth: null,
  };

  // ---------- storage ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
  };

  // ---------- Telegram Mini App ----------
  if (tgApp?.initData) {
    tgApp.ready();
    tgApp.expand();
    document.documentElement.dataset.theme = tgApp.colorScheme === 'dark' ? 'dark' : 'light';
    const p = tgApp.themeParams || {};
    const root = document.documentElement.style;
    if (p.button_color) root.setProperty('--accent', p.button_color);
    if (p.button_text_color) root.setProperty('--accent-text', p.button_text_color);
    if (p.bg_color) root.setProperty('--surface', p.bg_color);
    if (p.secondary_bg_color) root.setProperty('--bg', p.secondary_bg_color);
    if (p.text_color) root.setProperty('--text', p.text_color);
    if (p.hint_color) root.setProperty('--muted', p.hint_color);
  }

  // ---------- auth ----------
  function initAuth() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromHash = hash.get('token');
    if (fromHash) {
      store.set(TOKEN_KEY, fromHash);
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (tgApp?.initData) state.auth = { initData: tgApp.initData };
    else if (store.get(TOKEN_KEY)) state.auth = { token: store.get(TOKEN_KEY) };

    if (!state.auth) {
      showBanner('Чтобы отправлять посты, откройте бота в Telegram и нажмите /start — он пришлёт кнопку для входа в редактор. Писать и смотреть превью можно и без этого.');
      return;
    }
    fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth: state.auth }) })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          const u = data.user;
          $('#recipient').textContent = `Пост придёт: ${u.first_name || (u.username ? '@' + u.username : 'id ' + u.id)}`;
        } else {
          showBanner('Ссылка для входа недействительна. Отправьте боту /link, чтобы получить новую.');
        }
      })
      .catch(() => {});
  }

  function showBanner(text) {
    const b = $('#authBanner');
    b.textContent = text;
    b.hidden = false;
  }

  // ---------- toast / confirm ----------
  let toastTimer;
  function toast(text, isError = false) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 3000);
  }

  function askConfirm(text) {
    if (tgApp?.initData && tgApp.showConfirm) {
      return new Promise((resolve) => {
        try { tgApp.showConfirm(text, resolve); } catch { resolve(window.confirm(text)); }
      });
    }
    return Promise.resolve(window.confirm(text));
  }

  // ---------- editing helpers ----------
  function replaceRange(start, end, text, selStart, selEnd) {
    editor.focus();
    editor.setSelectionRange(start, end);
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      editor.setRangeText(text, start, end, 'end');
      onInput();
    }
    if (selStart != null) editor.setSelectionRange(selStart, selEnd ?? selStart);
  }

  function wrap(before, after, placeholder) {
    const s = editor.selectionStart;
    const e = editor.selectionEnd;
    const inner = editor.value.slice(s, e) || placeholder;
    replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
  }

  function prefixLines(prefix, placeholder) {
    const v = editor.value;
    const s = editor.selectionStart;
    const e = editor.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = v.length;
    const block = v.slice(lineStart, lineEnd);
    const pfx = (i) => prefix.replace('#n', String(i + 1));
    if (!block.trim()) {
      const text = pfx(0) + placeholder;
      replaceRange(lineStart, lineEnd, text, lineStart + pfx(0).length, lineStart + text.length);
      return;
    }
    const text = block.split('\n').map((l, i) => pfx(i) + l).join('\n');
    replaceRange(lineStart, lineEnd, text, lineStart, lineStart + text.length);
  }

  /** Вставляет блок на отдельных строках. В шаблоне {sel} — выделение или плейсхолдер, который будет выделен. */
  function insertBlock(template, placeholder = 'текст') {
    const v = editor.value;
    const s = editor.selectionStart;
    const e = editor.selectionEnd;
    const sel = v.slice(s, e) || placeholder;
    const before = v.slice(0, s);
    const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const after = v.slice(e);
    const trail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const idx = template.indexOf('{sel}');
    const body = template.replace('{sel}', sel);
    const text = lead + body + trail;
    const selStart = idx === -1 ? s + text.length : s + lead.length + idx;
    const selEnd = idx === -1 ? selStart : selStart + sel.length;
    replaceRange(s, e, text, selStart, selEnd);
  }

  function nextFootnoteNumber() {
    const nums = [...editor.value.matchAll(/\[\^(\d+)\]|#note-(\d+)/g)].map((m) => Number(m[1] || m[2]));
    return nums.length ? Math.max(...nums) + 1 : 1;
  }

  function insertFootnote() {
    const n = nextFootnoteNumber();
    const s = editor.selectionStart;
    if (state.format === 'markdown') {
      const ref = `[^${n}]`;
      const def = `\n\n[^${n}]: Текст сноски`;
      replaceRange(s, editor.selectionEnd, ref);
      const end = editor.value.replace(/\s+$/, '').length;
      replaceRange(end, editor.value.length, def, end + def.length - 'Текст сноски'.length, end + def.length);
    } else {
      const ref = `<sup><a href="#note-${n}">${n}</a></sup>`;
      const def = `\n\n<p><a name="note-${n}"></a>${n}. Текст сноски</p>`;
      replaceRange(s, editor.selectionEnd, ref);
      const end = editor.value.replace(/\s+$/, '').length;
      const tail = def.length - '</p>'.length;
      replaceRange(end, editor.value.length, def, end + tail - 'Текст сноски'.length, end + tail);
    }
  }

  // ---------- toolbar ----------
  const md = (fn) => ({ markdown: fn });
  const both = (mdFn, htmlFn) => ({ markdown: mdFn, html: htmlFn });

  const ACTIONS = [
    { label: 'H1', title: 'Заголовок 1', ...both(() => prefixLines('# ', 'Заголовок'), () => wrap('<h1>', '</h1>', 'Заголовок')) },
    { label: 'H2', title: 'Заголовок 2', ...both(() => prefixLines('## ', 'Заголовок'), () => wrap('<h2>', '</h2>', 'Заголовок')) },
    { label: 'H3', title: 'Заголовок 3', ...both(() => prefixLines('### ', 'Заголовок'), () => wrap('<h3>', '</h3>', 'Заголовок')) },
    'sep',
    { label: '<b>B</b>', title: 'Жирный (Ctrl+B)', key: 'b', ...both(() => wrap('**', '**', 'жирный'), () => wrap('<b>', '</b>', 'жирный')) },
    { label: '<i>I</i>', title: 'Курсив (Ctrl+I)', key: 'i', ...both(() => wrap('*', '*', 'курсив'), () => wrap('<i>', '</i>', 'курсив')) },
    { label: '<u>U</u>', title: 'Подчёркнутый (Ctrl+U)', key: 'u', ...both(() => wrap('<u>', '</u>', 'подчёркнутый'), () => wrap('<u>', '</u>', 'подчёркнутый')) },
    { label: '<s>S</s>', title: 'Зачёркнутый', ...both(() => wrap('~~', '~~', 'зачёркнутый'), () => wrap('<s>', '</s>', 'зачёркнутый')) },
    { label: '<mark>M</mark>', title: 'Выделение маркером', ...both(() => wrap('==', '==', 'выделение'), () => wrap('<mark>', '</mark>', 'выделение')) },
    { label: '▒', title: 'Спойлер', ...both(() => wrap('||', '||', 'спойлер'), () => wrap('<tg-spoiler>', '</tg-spoiler>', 'спойлер')) },
    { label: '&lt;/&gt;', title: 'Моноширинный код', ...both(() => wrap('`', '`', 'код'), () => wrap('<code>', '</code>', 'код')) },
    { label: '🔗', title: 'Ссылка (Ctrl+K)', key: 'k', ...both(() => wrap('[', '](https://)', 'текст ссылки'), () => wrap('<a href="https://">', '</a>', 'текст ссылки')) },
    { label: 'x²', title: 'Верхний индекс', ...both(() => wrap('<sup>', '</sup>', '2'), () => wrap('<sup>', '</sup>', '2')) },
    'sep',
    { label: '•', title: 'Маркированный список', ...both(() => prefixLines('- ', 'пункт'), () => insertBlock('<ul>\n<li>{sel}</li>\n<li>пункт</li>\n</ul>', 'пункт')) },
    { label: '1.', title: 'Нумерованный список', ...both(() => prefixLines('#n. ', 'пункт'), () => insertBlock('<ol>\n<li>{sel}</li>\n<li>пункт</li>\n</ol>', 'пункт')) },
    { label: '☑', title: 'Список задач', ...both(() => prefixLines('- [ ] ', 'задача'), () => insertBlock('<ul>\n<li><input type="checkbox">{sel}</li>\n<li><input type="checkbox" checked>готово</li>\n</ul>', 'задача')) },
    { label: '❝', title: 'Цитата', ...both(() => prefixLines('>', 'цитата'), () => wrap('<blockquote>', '</blockquote>', 'цитата')) },
    { label: '❝▾', title: 'Сворачиваемая цитата', ...both(() => insertBlock('<blockquote expandable>{sel}</blockquote>', 'длинная цитата, которая сворачивается'), () => insertBlock('<blockquote expandable>{sel}</blockquote>', 'длинная цитата, которая сворачивается')) },
    { label: '{ }', title: 'Блок кода', ...both(() => insertBlock('```python\n{sel}\n```', 'print("hello")'), () => insertBlock('<pre><code class="language-python">{sel}</code></pre>', 'print("hello")')) },
    { label: '▦', title: 'Таблица', ...both(
      () => insertBlock('| {sel} | Колонка 2 |\n|:---------|:--------:|\n| значение | значение |\n| значение | значение |', 'Колонка 1'),
      () => insertBlock('<table bordered>\n<tr><th>{sel}</th><th>Колонка 2</th></tr>\n<tr><td>значение</td><td>значение</td></tr>\n</table>', 'Колонка 1')) },
    { label: '▸', title: 'Раскрывающийся блок', ...both(
      () => insertBlock('<details><summary>{sel}</summary>\n\nСкрытое содержимое с **Markdown**.\n\n</details>', 'Заголовок блока'),
      () => insertBlock('<details><summary>{sel}</summary><p>Скрытое содержимое</p></details>', 'Заголовок блока')) },
    { label: '―', title: 'Разделитель', ...both(() => insertBlock('---{sel}', ''), () => insertBlock('<hr/>{sel}', '')) },
    'sep',
    { label: '∑', title: 'Формула в строке', ...both(() => wrap('$', '$', 'x^2 + y^2'), () => wrap('<tg-math>', '</tg-math>', 'x^2 + y^2')) },
    { label: '∫', title: 'Блочная формула', ...both(() => insertBlock('$$\n{sel}\n$$', 'E = mc^2'), () => insertBlock('<tg-math-block>{sel}</tg-math-block>', 'E = mc^2')) },
    { label: '¹', title: 'Сноска', ...both(insertFootnote, insertFootnote) },
    { label: '🕒', title: 'Дата и время (показывается в часовом поясе читателя)', ...both(
      () => wrap('![', `](tg://time?unix=${Math.floor(Date.now() / 1000)}&format=wDT)`, new Date().toLocaleString('ru')),
      () => wrap(`<tg-time unix="${Math.floor(Date.now() / 1000)}" format="wDT">`, '</tg-time>', new Date().toLocaleString('ru'))) },
    'sep',
    { label: '📎', title: 'Загрузить фото, видео, аудио или файл', ...both(pickFiles, pickFiles) },
    { label: '🖼', title: 'Медиа по ссылке', ...both(
      () => insertBlock('![](https://{sel})', 'example.com/photo.jpg'),
      () => insertBlock('<img src="https://{sel}"/>', 'example.com/photo.jpg')) },
  ];

  function buildToolbar() {
    const bar = $('#toolbar');
    for (const a of ACTIONS) {
      if (a === 'sep') {
        bar.appendChild(Object.assign(document.createElement('span'), { className: 'sep' }));
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = a.label;
      btn.title = a.title;
      btn.setAttribute('aria-label', a.title);
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // не терять выделение
      btn.addEventListener('click', () => runAction(a));
      bar.appendChild(btn);
    }
  }

  function runAction(a) {
    (a[state.format] || a.markdown)();
  }

  // ---------- cheatsheet ----------
  const CHEATS = {
    markdown: [
      ['Заголовки', '# H1\n## H2\n### H3'],
      ['Текст', '**жирный** *курсив* ~~зачёркнутый~~ <u>подчёркнутый</u>'],
      ['Маркер и спойлер', '==выделено== и ||спойлер||'],
      ['Индексы', 'H<sub>2</sub>O, x<sup>2</sup>'],
      ['Ссылка', '[текст](https://t.me/)'],
      ['Упоминание', '[Имя](tg://user?id=123456789)'],
      ['Списки', '- пункт\n- пункт\n\n1. первый\n2. второй'],
      ['Задачи', '- [x] сделано\n- [ ] в планах'],
      ['Цитата', '>Цитата\n>продолжение'],
      ['Сворачиваемая цитата', '<blockquote expandable>Длинный текст…</blockquote>'],
      ['Цитата по центру', '<aside>Цитата<cite>Автор</cite></aside>'],
      ['Код', '```js\nconsole.log("hi")\n```'],
      ['Таблица', '| A | B |\n|:--|--:|\n| 1 | 2 |'],
      ['Сноска', 'Текст[^1]\n\n[^1]: Сноска'],
      ['Формулы', '$x^2$\n\n$$E = mc^2$$'],
      ['Раскрывающийся блок', '<details><summary>Ещё</summary>\n\nТекст\n\n</details>'],
      ['Медиа с подписью', '![](https://example.com/photo.jpg "Подпись")'],
      ['Коллаж', '<tg-collage>\n\n![](https://example.com/1.jpg)\n![](https://example.com/2.jpg)\n\n</tg-collage>'],
      ['Слайдшоу', '<tg-slideshow>\n\n![](https://example.com/1.jpg)\n![](https://example.com/2.jpg)\n\n</tg-slideshow>'],
      ['Карта', '<tg-map lat="55.75" long="37.62" zoom="13"/>'],
      ['Кастомный эмодзи', '![👍](tg://emoji?id=5368324170671202286)'],
      ['Кнопки', '<tg-button-row align="center">\n  <tg-button type="url" style="primary" url="https://t.me">Открыть</tg-button>\n  <tg-button type="copy_text" text="PROMO2026">Промокод</tg-button>\n</tg-button-row>'],
      ['Подвал', '<footer>Подписывайтесь на канал</footer>'],
      ['Разделитель', '---'],
    ],
    html: [
      ['Заголовки', '<h1>H1</h1>\n<h2>H2</h2>'],
      ['Текст', '<b>жирный</b> <i>курсив</i> <u>подчёркнутый</u> <s>зачёркнутый</s>'],
      ['Маркер и спойлер', '<mark>выделено</mark> <tg-spoiler>спойлер</tg-spoiler>'],
      ['Ссылка', '<a href="https://t.me/">текст</a>'],
      ['Абзац', '<p>Текст абзаца</p>'],
      ['Списки', '<ul><li>пункт</li></ul>\n<ol start="3"><li>третий</li></ol>'],
      ['Задачи', '<ul>\n<li><input type="checkbox" checked>сделано</li>\n<li><input type="checkbox">в планах</li>\n</ul>'],
      ['Цитата', '<blockquote>Цитата<cite>Автор</cite></blockquote>'],
      ['Сворачиваемая цитата', '<blockquote expandable>Длинный текст…</blockquote>'],
      ['Цитата по центру', '<aside>Цитата<cite>Автор</cite></aside>'],
      ['Код', '<pre><code class="language-js">console.log("hi")</code></pre>'],
      ['Таблица', '<table bordered striped>\n<caption>Подпись</caption>\n<tr><th>A</th><th>B</th></tr>\n<tr><td>1</td><td align="right">2</td></tr>\n</table>'],
      ['Формулы', '<tg-math>x^2</tg-math>\n<tg-math-block>E = mc^2</tg-math-block>'],
      ['Раскрывающийся блок', '<details open><summary>Ещё</summary><p>Текст</p></details>'],
      ['Фото с подписью', '<figure><img src="https://example.com/photo.jpg"/><figcaption>Подпись<cite>Автор</cite></figcaption></figure>'],
      ['Коллаж', '<tg-collage><img src="https://example.com/1.jpg"/><img src="https://example.com/2.jpg"/></tg-collage>'],
      ['Карта', '<tg-map lat="55.75" long="37.62" zoom="13"/>'],
      ['Дата', '<tg-time unix="1647531900" format="wDT">22:45 завтра</tg-time>'],
      ['Кнопки', '<tg-button-row align="center">\n  <tg-button type="url" style="primary" url="https://t.me">Открыть</tg-button>\n</tg-button-row>'],
      ['Подвал', '<footer>Подписывайтесь на канал</footer>'],
      ['Разделитель', '<hr/>'],
    ],
  };

  function renderCheatsheet() {
    const list = $('#cheatList');
    list.innerHTML = '';
    for (const [title, code] of CHEATS[state.format]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cheat-item';
      btn.innerHTML = `<b></b><code></code>`;
      btn.querySelector('b').textContent = title;
      btn.querySelector('code').textContent = code;
      btn.addEventListener('click', () => {
        $('#cheatsheet').close();
        insertBlock(code + '{sel}', '');
      });
      list.appendChild(btn);
    }
  }

  // ---------- templates ----------
  const TEMPLATES = {
    showcase: `# Rich-посты в Telegram

Короткое вступление с **жирным**, *курсивом*, ~~зачёркнутым~~, <u>подчёркнутым</u>, ==выделением==, \`кодом\` и ||спойлером||.

## Чек-лист

- [x] Придумать идею
- [x] Написать пост в редакторе
- [ ] Переслать в канал

## Цифры недели

| Метрика | Значение |
|:--------|---------:|
| Подписчики | **12 400** |
| Охват поста | 68% |
| Репосты | 312 |

>Хорошее форматирование — половина успеха поста.

<details><summary>Подробнее о форматировании</summary>

Внутри раскрывающегося блока работает **Markdown**:
- списки
- таблицы
- и даже формулы $a^2 + b^2 = c^2$

</details>

Блочная формула:

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

\`\`\`python
print("Привет, Telegram!")
\`\`\`

Факт со сноской[^1].

---

<footer>Подписывайтесь, чтобы не пропустить новое</footer>

[^1]: Источник: документация Telegram Bot API, раздел Rich messages.
`,
    announce: `# 🚀 Большое обновление

Мы выпустили новую версию — вот что изменилось:

1. **Скорость** — всё работает в два раза быстрее
2. **Тёмная тема** — наконец-то
3. **Экспорт** в PDF и Markdown

<blockquote expandable>Полный список изменений: исправлены ошибки синхронизации, улучшена работа офлайн, обновлены переводы, ускорена загрузка медиа, переработаны настройки уведомлений.</blockquote>

<tg-button-row align="center">
  <tg-button type="url" style="primary" url="https://t.me">Попробовать</tg-button>
</tg-button-row>
`,
    report: `# Отчёт за квартал

## Ключевые показатели

| Показатель | Q2 | Q3 | Δ |
|:-----------|---:|---:|:-:|
| Выручка, млн ₽ | 12.4 | 15.1 | ==+22%== |
| Клиенты | 840 | 1 020 | +21% |
| Отток | 4.1% | 3.2% | −0.9 п.п. |

## Выводы

- Рост выручки обеспечен новыми тарифами
- Отток снизился после запуска поддержки 24/7

<aside>Лучший квартал за историю компании<cite>Финансовый отдел</cite></aside>
`,
    faq: `# Частые вопросы

<details><summary>Как оформить подписку?</summary>

Откройте бота и нажмите **«Подписаться»**.

</details>

<details><summary>Можно ли вернуть деньги?</summary>

Да, в течение ==14 дней== после оплаты.

</details>

<details><summary>Есть ли промокод?</summary>

Есть: ||TELEGRAM2026||

</details>
`,
  };

  async function applyTemplate(name) {
    const text = TEMPLATES[name];
    if (!text) return;
    if (editor.value.trim() && !(await askConfirm('Заменить текущий текст шаблоном?'))) return;
    setFormat('markdown');
    editor.value = text;
    onInput();
    editor.focus();
  }

  // ---------- media files ----------
  const KIND_SCHEME = { photo: 'photo', video: 'video', animation: 'video', audio: 'audio', voice_note: 'audio', document: 'document' };
  const KIND_ICON = { photo: '🖼', video: '🎬', animation: '🎞', audio: '🎵', voice_note: '🎤', document: '📄' };

  function kindOf(file) {
    const t = file.type || '';
    if (t === 'image/gif') return 'animation';
    if (/^image\/(jpeg|png|webp|bmp)$/.test(t)) return 'photo';
    if (t.startsWith('video/')) return 'video';
    if (t === 'audio/ogg' || t === 'audio/opus') return 'voice_note';
    if (t.startsWith('audio/')) return 'audio';
    return 'document';
  }

  function pickFiles() {
    $('#fileInput').click();
  }

  function mediaSnippet(f) {
    const link = `tg://${KIND_SCHEME[f.kind]}?id=${f.id}`;
    if (state.format === 'markdown') return `![](${link})`;
    if (f.kind === 'photo') return `<img src="${link}"/>`;
    if (f.kind === 'video' || f.kind === 'animation') return `<video src="${link}"></video>`;
    if (f.kind === 'audio' || f.kind === 'voice_note') return `<audio src="${link}"></audio>`;
    return `<tg-document src="${link}"></tg-document>`;
  }

  function addFiles(fileList) {
    const snippets = [];
    for (const file of fileList) {
      const f = {
        id: 'f' + Math.random().toString(36).slice(2, 8),
        file,
        kind: kindOf(file),
        url: URL.createObjectURL(file),
      };
      state.files.push(f);
      snippets.push(mediaSnippet(f));
    }
    if (snippets.length) insertBlock(snippets.join('\n') + '{sel}', '');
    renderAttachments();
    const total = state.files.reduce((s, f) => s + f.file.size, 0);
    if (total > MAX_UPLOAD_BYTES) toast(`Файлы весят ${(total / 1048576).toFixed(1)} МБ — больше лимита 3 МБ. Для крупных файлов используйте ссылки.`, true);
  }

  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    box.hidden = state.files.length === 0;
    for (const f of state.files) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const thumb = f.kind === 'photo' || f.kind === 'animation'
        ? Object.assign(document.createElement('img'), { src: f.url, alt: '' })
        : Object.assign(document.createElement('span'), { className: 'ico', textContent: KIND_ICON[f.kind] });
      const name = Object.assign(document.createElement('span'), { textContent: `${f.file.name} · ${(f.file.size / 1024).toFixed(0)} КБ` });
      const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: 'Убрать файл' });
      del.addEventListener('click', () => {
        state.files = state.files.filter((x) => x !== f);
        URL.revokeObjectURL(f.url);
        renderAttachments();
        renderPreview();
      });
      chip.append(thumb, name, del);
      box.appendChild(chip);
    }
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // ---------- preview ----------
  const PURIFY = {
    ADD_TAGS: ['tg-spoiler', 'tg-emoji', 'tg-time', 'tg-math', 'tg-math-block', 'tg-reference', 'tg-collage', 'tg-slideshow',
      'tg-map', 'tg-document', 'tg-button', 'tg-button-row', 'tg-thinking', 'aside', 'details', 'summary', 'figure',
      'figcaption', 'cite', 'footer', 'video', 'audio', 'mark', 'ins'],
    ADD_ATTR: ['expandable', 'open', 'emoji-id', 'unix', 'format', 'lat', 'long', 'zoom', 'url', 'data', 'query', 'text',
      'valign', 'bordered', 'striped', 'compact', 'reversed', 'tg-spoiler', 'forward-text'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|tg|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function mediaKindByUrl(href) {
    const m = /^tg:\/\/(photo|video|audio|document)\?id=([\w-]+)/.exec(href);
    if (m) {
      const f = state.files.find((x) => x.id === m[2]);
      return f ? f.kind : 'missing';
    }
    const path = href.split(/[?#]/)[0].toLowerCase();
    if (/\.(mp4|webm|mov|m4v)$/.test(path)) return 'video';
    if (/\.(mp3|m4a|ogg|oga|opus|wav|flac)$/.test(path)) return 'audio';
    if (/\.(jpe?g|png|webp|gif|bmp|svg|avif)$/.test(path) || !/\.\w{2,5}$/.test(path)) return 'photo';
    return 'document';
  }

  function mediaHtml(href, caption) {
    const kind = mediaKindByUrl(href);
    let inner;
    if (kind === 'photo' || kind === 'animation') inner = kind === 'animation' && href.startsWith('tg:')
      ? `<video src="${esc(href)}" autoplay muted loop playsinline></video>`
      : `<img src="${esc(href)}" alt="">`;
    else if (kind === 'video') inner = `<video src="${esc(href)}" controls playsinline></video>`;
    else if (kind === 'audio' || kind === 'voice_note') inner = `<audio src="${esc(href)}" controls></audio>`;
    else if (kind === 'missing') inner = `<div class="media-stub">⚠️ Файл не загружен — прикрепите его заново</div>`;
    else inner = `<tg-document src="${esc(href)}"></tg-document>`;
    return caption ? `<figure>${inner}<figcaption>${esc(caption)}</figcaption></figure>` : inner;
  }

  function inlineExt(name, open, close, tag) {
    const o = open.replace(/[|$]/g, '\\$&');
    const c = close.replace(/[|$]/g, '\\$&');
    const re = new RegExp(`^${o}(?=\\S)([\\s\\S]*?\\S)${c}`);
    return {
      name,
      level: 'inline',
      start: (src) => { const i = src.indexOf(open); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = re.exec(src);
        if (!m) return undefined;
        const token = { type: name, raw: m[0], text: m[1], tokens: [] };
        this.lexer.inline(m[1], token.tokens);
        return token;
      },
      renderer(token) { return `<${tag}>${this.parser.parseInline(token.tokens)}</${tag}>`; },
    };
  }

  marked.use({
    gfm: true,
    breaks: false,
    extensions: [
      inlineExt('mark', '==', '==', 'mark'),
      inlineExt('spoiler', '||', '||', 'tg-spoiler'),
      {
        name: 'blockMath',
        level: 'block',
        start: (src) => { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
          return m ? { type: 'blockMath', raw: m[0], text: m[1].trim() } : undefined;
        },
        renderer: (t) => `<tg-math-block>${esc(t.text)}</tg-math-block>`,
      },
      {
        name: 'inlineMath',
        level: 'inline',
        start: (src) => { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
          return m ? { type: 'inlineMath', raw: m[0], text: m[1] } : undefined;
        },
        renderer: (t) => `<tg-math>${esc(t.text)}</tg-math>`,
      },
    ],
    renderer: {
      code(code, lang) {
        if ((lang || '').trim() === 'math') return `<tg-math-block>${esc(code)}</tg-math-block>`;
        const cls = lang ? ` class="language-${esc(lang.trim().split(/\s/)[0])}"` : '';
        return `<pre><code${cls}>${esc(code)}</code></pre>`;
      },
      image(href, title, text) {
        href = href || '';
        if (href.startsWith('tg://emoji')) return esc(text || '');
        if (href.startsWith('tg://time')) {
          const p = new URLSearchParams(href.split('?')[1] || '');
          return `<tg-time unix="${esc(p.get('unix') || '')}">${esc(text || '')}</tg-time>`;
        }
        return mediaHtml(href, title);
      },
    },
  });

  /** Выносит определения сносок [^id]: … и заменяет ссылки на них (вне блоков кода). */
  function extractFootnotes(src) {
    const defs = new Map();
    const order = [];
    const parts = src.split(/(^```[\s\S]*?^```)/m);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm, (_, id, text) => {
        defs.set(id, text);
        return '';
      });
    }
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/\[\^([^\]\s]+)\]/g, (whole, id) => {
        if (!defs.has(id)) return whole;
        if (!order.includes(id)) order.push(id);
        const n = order.indexOf(id) + 1;
        return `<sup class="fn"><a href="#fn-${esc(id)}">${n}</a></sup>`;
      });
    }
    let footer = '';
    if (order.length) {
      footer = '<div class="footnotes"><ol>' +
        order.map((id) => `<li id="fn-${esc(id)}">${marked.parseInline(defs.get(id))}</li>`).join('') +
        '</ol></div>';
    }
    return { body: parts.join(''), footer };
  }

  /** HTML-парсер игнорирует «/>» у не-void элементов — раскрываем такие теги, чтобы они не поглотили соседний текст. */
  function expandSelfClosing(html) {
    return html.replace(/<(tg-map|tg-document|video|audio|tg-thinking)(\s[^<>]*?)?\s*\/>/g, '<$1$2></$1>');
  }

  function renderPreview() {
    const src = editor.value;
    let html;
    if (!src.trim()) {
      preview.innerHTML = '<p style="color:var(--muted)">Здесь появится превью поста.</p>';
      return;
    }
    if (state.format === 'markdown') {
      const { body, footer } = extractFootnotes(expandSelfClosing(src));
      html = marked.parse(body) + footer;
    } else {
      html = expandSelfClosing(src);
    }
    preview.innerHTML = DOMPurify.sanitize(html, PURIFY);
    enhancePreview();
  }

  function enhancePreview() {
    const renderMath = (el, display) => {
      try {
        katex.render(el.textContent, el, { displayMode: display, throwOnError: false });
      } catch { /* оставляем исходник */ }
    };
    preview.querySelectorAll('tg-math').forEach((el) => renderMath(el, false));
    preview.querySelectorAll('tg-math-block').forEach((el) => renderMath(el, true));

    // tg://… ссылки на загруженные файлы → локальные object URL
    preview.querySelectorAll('[src^="tg://"]').forEach((el) => {
      const m = /^tg:\/\/\w+\?id=([\w-]+)/.exec(el.getAttribute('src'));
      const f = m && state.files.find((x) => x.id === m[1]);
      if (f && el.tagName !== 'TG-DOCUMENT') {
        el.setAttribute('src', f.url);
        if (el.tagName === 'VIDEO' && !el.hasAttribute('autoplay')) el.setAttribute('controls', '');
      }
      if (el.tagName === 'TG-DOCUMENT') el.dataset.name = f ? f.file.name : 'файл';
    });
    preview.querySelectorAll('video:not([controls]):not([autoplay]), audio:not([controls])').forEach((el) => el.setAttribute('controls', ''));
    preview.querySelectorAll('tg-document').forEach((el) => {
      const name = el.dataset.name || decodeURIComponent((el.getAttribute('src') || '').split('/').pop() || 'файл');
      el.outerHTML = `<div class="media-stub">📄 ${esc(name)}</div>`;
    });
    preview.querySelectorAll('tg-map').forEach((el) => {
      const lat = el.getAttribute('lat');
      const long = el.getAttribute('long');
      el.outerHTML = `<div class="media-stub">📍 Карта: ${esc(lat)}, ${esc(long)}</div>`;
    });
    preview.querySelectorAll('img[src^="tg://emoji"]').forEach((el) => el.replaceWith(el.getAttribute('alt') || ''));
    preview.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    preview.querySelectorAll('tg-spoiler, [tg-spoiler]').forEach((el) => {
      if (el.tagName === 'TG-SPOILER') el.addEventListener('click', () => el.classList.toggle('revealed'));
      else el.style.filter = 'blur(12px)';
    });
    preview.querySelectorAll('blockquote[expandable]').forEach((el) => el.addEventListener('click', () => el.classList.toggle('open')));
  }

  // ---------- counter / draft ----------
  let previewTimer;
  function onInput() {
    const len = [...editor.value].length;
    const counter = $('#counter');
    counter.textContent = `${len.toLocaleString('ru')} / ${MAX_CHARS.toLocaleString('ru')}`;
    counter.classList.toggle('over', len > MAX_CHARS);
    store.set(DRAFT_KEY, JSON.stringify({ format: state.format, text: editor.value }));
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  }

  function setFormat(format) {
    state.format = format;
    document.querySelectorAll('[data-format]').forEach((b) => b.classList.toggle('active', b.dataset.format === format));
    editor.placeholder = format === 'markdown'
      ? 'Напишите пост в Markdown: # Заголовок, **жирный**, | таблицы |, ||спойлер||, $формулы$…'
      : 'Напишите пост в HTML: <h1>Заголовок</h1>, <b>жирный</b>, <table>…';
    renderCheatsheet();
    onInput();
  }

  // ---------- send ----------
  async function send() {
    if (!state.auth) {
      toast('Сначала откройте редактор из бота: отправьте боту /start.', true);
      return;
    }
    const text = editor.value;
    if (!text.trim()) {
      toast('Пост пустой.', true);
      return;
    }
    const referenced = [...text.matchAll(/tg:\/\/(?:photo|video|audio|document)\?id=([\w-]+)/g)].map((m) => m[1]);
    const missing = referenced.filter((id) => !state.files.some((f) => f.id === id));
    if (missing.length) {
      toast(`В тексте есть ссылки на файлы, которых нет (${missing.join(', ')}). Прикрепите их заново через 📎.`, true);
      return;
    }
    const used = state.files.filter((f) => referenced.includes(f.id));
    const size = used.reduce((s, f) => s + f.file.size, 0);
    if (size > MAX_UPLOAD_BYTES) {
      toast(`Файлы весят ${(size / 1048576).toFixed(1)} МБ, максимум — 3 МБ. Используйте ссылки на медиа.`, true);
      return;
    }

    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.textContent = 'Отправка…';
    try {
      const files = await Promise.all(used.map(async (f) => ({
        id: f.id, kind: f.kind, name: f.file.name, mime: f.file.type, data: await readBase64(f.file),
      })));
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth: state.auth,
          format: state.format,
          text,
          files,
          silent: $('#silent').checked,
          skipEntityDetection: $('#skipEntities').checked,
        }),
      });
      const data = res.status === 413 ? { error: 'Слишком большой запрос — уменьшите размер файлов.' } : await res.json().catch(() => ({}));
      if (data.ok) {
        toast('✅ Отправлено! Откройте чат с ботом и перешлите пост.');
        tgApp?.HapticFeedback?.notificationOccurred('success');
      } else {
        toast(`Ошибка: ${data.error || res.statusText}`, true);
        tgApp?.HapticFeedback?.notificationOccurred('error');
      }
    } catch (err) {
      toast(`Ошибка сети: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить в Telegram';
    }
  }

  // ---------- wiring ----------
  function init() {
    buildToolbar();

    let draft = null;
    try { draft = JSON.parse(store.get(DRAFT_KEY) || 'null'); } catch { /* битый черновик */ }
    if (draft?.text) editor.value = draft.text;
    setFormat(draft?.format === 'html' ? 'html' : 'markdown');

    editor.addEventListener('input', onInput);
    editor.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        send();
        return;
      }
      const a = ACTIONS.find((x) => x !== 'sep' && x.key === e.key.toLowerCase());
      if (a && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        runAction(a);
      }
    });

    document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.format !== state.format) {
        setFormat(b.dataset.format);
        if (editor.value.trim()) toast('Формат переключён. Существующая разметка не конвертируется.');
      }
    }));
    $('#templates').addEventListener('change', (e) => {
      applyTemplate(e.target.value);
      e.target.value = '';
    });
    $('#cheatBtn').addEventListener('click', () => $('#cheatsheet').showModal());
    $('#cheatsheet [data-close]').addEventListener('click', () => $('#cheatsheet').close());
    $('#cheatsheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('#fileInput').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    editor.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    document.querySelectorAll('.mobile-tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#workspace').dataset.pane = b.dataset.pane;
      if (b.dataset.pane === 'preview') renderPreview();
    }));
    $('#sendBtn').addEventListener('click', send);

    initAuth();
    renderPreview();
  }

  init();
})();
