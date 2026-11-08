// SPDX-License-Identifier: GPL-3.0-or-later
const $ = (id) => document.getElementById(id);
const native = typeof window.easyapp !== 'undefined';

$('env').textContent = native
  ? 'Нативный рантайм · права: ' + (easyapp.info().permissions.join(', ') || 'нет')
  : 'Браузер: нативные функции недоступны';

function report(el, message, isError) {
  el.textContent = message;
  el.style.color = isError ? '#c0392b' : '';
}

$('savePrivate').onclick = async () => {
  if (!native) return alert('Откройте скомпилированное приложение');
  try {
    await easyapp.privateFiles.write('note.txt', $('note').value);
    report($('fileInfo'), 'Сохранено в приватное хранилище приложения');
  } catch (e) { report($('fileInfo'), e.message, true); }
};

$('loadPrivate').onclick = async () => {
  if (!native) return;
  try {
    $('note').value = await easyapp.privateFiles.readText('note.txt');
    report($('fileInfo'), 'Заметка загружена');
  } catch (e) { report($('fileInfo'), e.message, true); }
};

$('export').onclick = async () => {
  if (!native) return alert('Откройте скомпилированное приложение');
  try {
    await easyapp.files.exportText('note.txt', $('note').value);
    report($('fileInfo'), 'Файл сохранён на устройство');
  } catch (e) { report($('fileInfo'), e.message, true); }
};

$('import').onclick = async () => {
  if (!native) return alert('Откройте скомпилированное приложение');
  try {
    const picked = await easyapp.files.import({ accept: 'text/plain' });
    if (!picked) return report($('fileInfo'), 'Импорт отменён');
    $('note').value = new TextDecoder().decode(picked.data);
    report($('fileInfo'), 'Импортирован ' + picked.name + ' (' + picked.data.length + ' байт)');
  } catch (e) { report($('fileInfo'), e.message, true); }
};

$('fetch').onclick = async () => {
  if (!native) return alert('Откройте скомпилированное приложение');
  report($('netOut'), 'Запрос…');
  try {
    const res = await easyapp.fetch($('url').value, { headers: { 'User-Agent': 'EasyApp-Demo' } });
    const text = await res.text();
    report($('netOut'), 'HTTP ' + res.status + '\n\n' + text.slice(0, 1500));
  } catch (e) { report($('netOut'), e.message, true); }
};
