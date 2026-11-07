# Notion → Claude Code relay (experimental)

Локальный Anthropic-совместимый endpoint, который выполняет запросы через активную сессию Notion в Chrome.

```text
Claude Code → http://127.0.0.1:8787 → background.js → Notion Personal Agent → ответ
```

URL и локальный ключ хранятся в `relay-config.json`. Ключ защищает только loopback-endpoint; это не ключ Anthropic и не ключ Notion.

## Запуск

1. Запусти `start-relay.cmd` и оставь окно открытым.
2. В `chrome://extensions` перезагрузи **Notion AI Effort Control 2.69** и прими новые localhost/alarms permissions.
3. Открой авторизованный `https://app.notion.com` в обычной вкладке и обнови её.
4. Проверь подключение:

   ```bash
   curl http://127.0.0.1:8787/health
   ```

   Нужно: `"relayConnected":true`.

## Claude Code

Из этой папки:

```cmd
claude-code.cmd --bare --tools "" --model claude-opus-4-6 -p "Ответь одним словом: работает"
```

Или интерактивно:

```cmd
claude-code.cmd
```

`claude.js` автоматически выставляет:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<ключ из relay-config.json>
```

## Что делает relay

- Для каждого API-запроса создаёт **новый Personal Agent тред** с полной историей в тексте.
- Модели `opus`/остальные по умолчанию → Notion `albuquerque-quinn` (Opus 5.5), effort `max`.
- Модели с `sonnet` в имени → `almond-croissant-low`.
- Не использует follow-up Auto routing Notion.
- Поддерживает обычный Anthropic Messages JSON и SSE `stream=true`.

## Ограничения MVP

- Только текст. Изображения пока заменяются текстовой пометкой.
- Relay не возвращает `tool_use`, поэтому полноценные инструменты Claude Code для редактирования файлов пока не работают. Для простого чата используй `--tools ""`.
- Token usage возвращается как `0`: Notion не предоставляет Anthropic token accounting.
- Ответ отправляется после завершения запроса Notion; SSE эмулируется одним text delta, это не настоящий token streaming.
- Нужна открытая авторизованная вкладка Notion и запущенный локальный сервер.

## Проверки

```bash
node --test test.js
```

Реальный Claude Code `2.1.316` был проверен через endpoint с test-only `mock-browser.js`; mock не является ответом Notion. Для реальной проверки после запуска Chrome relay используй команду из раздела «Claude Code».

## Файлы

- `server.js` — HTTP server, auth, очередь, Anthropic JSON/SSE.
- `start.js` — генерация/чтение URL и ключа, запуск server.
- `claude.js` — запуск установленного Claude Code с нужными env vars.
- `../relay-background.js` — Chrome long-poll и доставка ответа.
- `../content.js` / `../inject.js` — мост в Notion Personal Agent.
- `../relay-settings.js` — сгенерированная localhost-конфигурация расширения.
