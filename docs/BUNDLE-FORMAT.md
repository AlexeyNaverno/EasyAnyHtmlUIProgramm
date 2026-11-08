# Формат входного бандла

Компилятор принимает **один файл**: `.html` или `.zip`.

## Вариант A: один HTML-файл

Весь CSS и JS внутри файла. Подходит для небольших приложений.

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- easyapp:name Моё приложение -->
  <!-- easyapp:id org.example.myapp -->
  <!-- easyapp:version 1.0.0 -->
  <!-- easyapp:permission files -->
  <title>Моё приложение</title>
  <style>body{font-family:system-ui;margin:16px}</style>
</head>
<body>
  <script>/* логика */</script>
</body>
</html>
```

Имя файла может быть любым: оно станет точкой входа автоматически.

## Вариант B: ZIP-архив

```
index.html          точка входа
style.css
app.js
assets/logo.png
easyapp.json        необязательно
```

Правила:

* Только **относительные** пути: `./style.css`, не `/style.css`.
  Абсолютные пути компилятор перепишет автоматически и выдаст предупреждение.
* Запрещены `..`, абсолютные пути и обратные слеши — архив будет отклонён.
* Если всё лежит в одной папке-обёртке (`myapp/index.html`), она снимается.
* Точка входа: `index.html`, либо самый верхний `.html`, либо значение `entry`.
* Лимиты: 200 МиБ в распакованном виде, 20 000 файлов.
* Файлы `__easyapp_*` зарезервированы рантаймом и игнорируются.

## Директивы

| Директива | Пример | По умолчанию |
|---|---|---|
| `easyapp:name` | `<!-- easyapp:name Мой редактор -->` | `EasyApp` |
| `easyapp:id` | `<!-- easyapp:id org.example.editor -->` | `org.easyapp.app` |
| `easyapp:version` | `<!-- easyapp:version 1.2.0 -->` | `1.0.0` |
| `easyapp:versioncode` | `<!-- easyapp:versioncode 5 -->` | `1` |
| `easyapp:permission` | `<!-- easyapp:permission internet -->` | нет прав |
| `easyapp:entry` | `<!-- easyapp:entry main.html -->` | `index.html` |
| `easyapp:orientation` | `<!-- easyapp:orientation portrait -->` | `unspecified` |
| `easyapp:description` | `<!-- easyapp:description Редактор заметок -->` | пусто |
| `easyapp:author` | `<!-- easyapp:author Ivan -->` | пусто |
| `easyapp:config` | JSON-объект целиком | — |

Несколько прав можно перечислить через пробел или запятую:

```html
<!-- easyapp:permission internet files -->
<!-- easyapp:permission internet, files -->
```

JSON-блок:

```html
<!-- easyapp:config {"name":"My App","permissions":["internet"],"versionCode":3} -->
```

### Приоритет

```
значения по умолчанию  <  easyapp.json  <  easyapp:config  <  отдельные директивы  <  галочки в UI
```

## easyapp.json

```json
{
  "id": "org.example.myapp",
  "name": "Моё приложение",
  "version": "1.0.0",
  "versionCode": 1,
  "entry": "index.html",
  "permissions": ["internet", "files"],
  "orientation": "unspecified",
  "description": "Описание для ярлыка",
  "author": "Имя автора"
}
```

## Ограничения идентификатора

`id` — обратный DNS, минимум два сегмента, каждый начинается с буквы:

* подходит: `org.example.app`, `com.mycompany.tool2`
* не подходит: `myapp`, `org.1app`, `org.my-app`, `org..app`

## Проверка перед сборкой

```bash
node apps/cli/src/index.mjs inspect app.zip
```

Линтер сообщает:

* **error** — внешний CDN-ресурс без права `internet` (приложение не заработает офлайн);
* **warning** — используется `fetch`, но право `internet` не включено;
* **warning** — используется `easyapp.files`, но право `files` не включено;
* **info** — используется `localStorage`, лучше взять `easyapp.storage`.

Ошибки блокируют сборку, предупреждения — нет.
