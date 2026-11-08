# API рантайма: window.easyapp

Объект существует только внутри скомпилированного приложения. Всегда проверяйте
его наличие, чтобы страница работала и в обычном браузере:

```js
if (typeof window.easyapp === 'undefined') {
  // открыто в браузере — нативные функции недоступны
}
```

Все методы асинхронные (`Promise`), кроме `info()` и `hasPermission()`.
Бинарные данные — `Uint8Array`.

## Информация

```js
easyapp.info();                     // { id, name, version, permissions, entry, ... }
easyapp.hasPermission('internet');  // true / false
```

## Настройки — всегда доступны

Небольшое постоянное хранилище ключ-значение в профиле приложения.

```js
await easyapp.storage.set('theme', 'dark');
const theme = await easyapp.storage.get('theme');   // '' если ключа нет
await easyapp.storage.remove('theme');
await easyapp.storage.keys();                       // ['theme', ...]
```

Значения — строки. Для объектов используйте `JSON.stringify`.

## Приватные файлы — всегда доступны

Песочница приложения, не видна другим программам и не требует прав.

```js
await easyapp.privateFiles.write('data.bin', bytes);      // Uint8Array | string
await easyapp.privateFiles.write('note.txt', 'текст');
const bytes = await easyapp.privateFiles.read('data.bin'); // Uint8Array
const text  = await easyapp.privateFiles.readText('note.txt');
await easyapp.privateFiles.list();                         // ['note.txt', ...]
await easyapp.privateFiles.list('subfolder');
await easyapp.privateFiles.remove('note.txt');
```

Пути относительные, вложенные папки создаются автоматически.
Попытка выйти за пределы песочницы (`../`) отклоняется.

## Файлы устройства — право `files`

Доступ только через системный диалог: пользователь выбирает конкретный файл.

```js
const picked = await easyapp.files.import({ accept: 'application/json' });
// picked = { name: 'data.json', data: Uint8Array }
// picked = null, если пользователь нажал «Отмена»

if (picked) {
  const text = new TextDecoder().decode(picked.data);
}

await easyapp.files.export('report.csv', csvBytes);
await easyapp.files.exportText('note.txt', 'содержимое');
const t = await easyapp.files.importText({ accept: 'text/plain' }); // { name, text }
```

На Android используется Storage Access Framework, поэтому разрешение
на доступ ко всему хранилищу не запрашивается.

## Сеть — право `internet`

```js
const res = await easyapp.fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ q: 'поиск' }),
  timeout: 30000,
});

res.status;               // 200
res.ok;                   // true при 2xx
res.headers;              // { 'content-type': '...' }
await res.text();
await res.json();
await res.bytes();        // Uint8Array
await res.arrayBuffer();
```

Отличия от браузерного `fetch`:

* **нет ограничений CORS** — запрос выполняет хост, а не веб-движок;
* поддерживаются только `http` и `https`;
* при отсутствии права вызов отклоняется сразу.

## Прочее

```js
await easyapp.log('отладочное сообщение');  // logcat / stderr
await easyapp.exit();                       // закрыть окно
```

## Обработка ошибок

Любой вызов может быть отклонён. Оборачивайте в `try/catch`:

```js
try {
  await easyapp.files.exportText('out.txt', text);
} catch (err) {
  // «Permission "files" is not granted for this application»
  // «Export cancelled»
  showMessage(err.message);
}
```

Типичные причины отказа:

| Сообщение | Причина |
|---|---|
| `Permission "internet" is not granted` | не включена галочка/директива |
| `Permission "files" is not granted` | не включена галочка/директива |
| `Export cancelled` | пользователь закрыл диалог сохранения |
| `File not found` | нет такого приватного файла |
| `Unsafe path` | путь содержит `..` или абсолютный |
| `EasyApp native bridge is unavailable` | страница открыта вне приложения |
