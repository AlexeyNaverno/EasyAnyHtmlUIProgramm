// SPDX-License-Identifier: GPL-3.0-or-later
import { createApi } from './api.js';

const $ = (id) => document.getElementById(id);

let api = null;

let fileBytes = null;
let fileName = '';
let targets = [];
let permissionsTouched = false;

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------ targets */

async function loadTargets() {
  targets = await api.targets();
  const select = $('target');
  select.innerHTML = targets.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  // In a compiled compiler app only the pure-JS targets can run.
  select.value = api.canBuildNative ? 'windows-x64' : 'source-project';
  if (!api.canBuildNative) {
    for (const option of select.options) {
      if (!['web-bundle', 'source-project'].includes(option.value)) {
        option.disabled = true;
        option.textContent += ' — нужен ПК';
      }
    }
  }
  updateTargetDesc();
}

function updateTargetDesc() {
  const t = targets.find((x) => x.id === $('target').value);
  $('targetDesc').textContent = t ? t.description : '';
  renderToolchain(t);
}

let doctorReport = null;

async function loadDoctor() {
  try {
    doctorReport = await api.doctor();
    renderToolchain(targets.find((x) => x.id === $('target').value));
  } catch { /* server may be starting */ }
}

function renderToolchain(target) {
  if (!doctorReport || !target) { $('toolchain').innerHTML = ''; return; }
  const labels = {
    zig: 'Zig', java17: 'JDK 17', androidSdk: 'Android SDK',
    cc: 'C compiler', webkit2gtk: 'WebKitGTK',
  };
  const keys = { java17: 'java' };
  $('toolchain').innerHTML = target.requires.map((req) => {
    const info = doctorReport[keys[req] || req];
    const ok = info && info.available;
    return `<span class="tc ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${esc(labels[req] || req)}</span>`;
  }).join('') || '<span class="tc ok">Тулчейн не требуется</span>';
}

/* ------------------------------------------------------------- inspect */

async function handleFile(file) {
  fileName = file.name;
  fileBytes = new Uint8Array(await file.arrayBuffer());
  $('fileName').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KiB`;
  $('buildBtn').disabled = false;
  permissionsTouched = false;
  await runInspect();
}

async function runInspect() {
  if (!fileBytes) return;
  setStatus('Анализ файла…', 'busy');
  const data = await api.inspect(fileBytes, fileName, null);
  const out = $('inspectOut');
  out.hidden = false;

  if (!data.ok) {
    out.innerHTML = `<div class="issue error">${esc(data.error)}</div>`;
    $('buildBtn').disabled = true;
    setStatus('Ошибка разбора', 'err');
    return;
  }

  const m = data.manifest;
  // Auto-fill fields and checkboxes from the parsed manifest.
  $('appName').placeholder = m.name;
  $('appId').placeholder = m.id;
  $('appVersion').placeholder = m.version;
  if (!permissionsTouched) {
    $('permInternet').checked = m.permissions.includes('internet');
    $('permFiles').checked = m.permissions.includes('files');
  }

  const perms = ['internet', 'files'].map((p) => (
    `<span class="badge ${m.permissions.includes(p) ? 'on' : ''}">${p}</span>`
  )).join('');

  out.innerHTML = `
    <dl class="kv">
      <dt>Тип</dt><dd>${esc(data.sourceKind)}</dd>
      <dt>Точка входа</dt><dd>${esc(data.entry)}</dd>
      <dt>Файлов</dt><dd>${data.fileCount} · ${(data.totalBytes / 1024).toFixed(1)} KiB</dd>
      <dt>Название</dt><dd>${esc(m.name)}</dd>
      <dt>ID</dt><dd>${esc(m.id)}</dd>
      <dt>Версия</dt><dd>${esc(m.version)}</dd>
      <dt>Права</dt><dd>${perms}</dd>
    </dl>
    ${data.directives.length ? `<p class="note">Найдено директив: ${data.directives.length}</p>` : ''}
    ${data.warnings.map((w) => `<div class="issue warning">${esc(w)}</div>`).join('')}
    ${data.issues.map((i) => `<div class="issue ${esc(i.level)}"><b>${esc(i.file)}</b>: ${esc(i.message)}</div>`).join('')}
  `;
  const hasError = data.issues.some((i) => i.level === 'error');
  $('buildBtn').disabled = hasError;
  setStatus(hasError ? 'Есть ошибки в бандле' : 'Файл готов к сборке', hasError ? 'err' : 'ok');
}

/* --------------------------------------------------------------- build */

function currentOverrides() {
  const overrides = {};
  if ($('appName').value.trim()) overrides.name = $('appName').value.trim();
  if ($('appId').value.trim()) overrides.id = $('appId').value.trim();
  if ($('appVersion').value.trim()) overrides.version = $('appVersion').value.trim();
  if (permissionsTouched) {
    overrides.permissions = [];
    if ($('permInternet').checked) overrides.permissions.push('internet');
    if ($('permFiles').checked) overrides.permissions.push('files');
  }
  return overrides;
}

async function runBuild() {
  if (!fileBytes) return;
  const btn = $('buildBtn');
  const out = $('buildOut');
  btn.disabled = true;
  out.hidden = false;
  out.innerHTML = '<div class="log">Сборка началась…</div>';
  setStatus('Сборка… это может занять минуту', 'busy');

  try {
    const data = await api.build(fileBytes, fileName, $('target').value, currentOverrides());
    const log = (data.log || []).join('\n');

    if (data.ok) {
      out.innerHTML = `
        <div class="log">${esc(log)}</div>
        ${(data.warnings || []).map((w) => `<div class="issue warning">${esc(w)}</div>`).join('')}
        ${data.downloadUrl ? `<a class="dl" href="${esc(data.downloadUrl)}">Скачать ${esc(data.filename)}</a>` : ''}
        ${data.blobUrl ? `<a class="dl" href="${esc(data.blobUrl)}" download="${esc(data.filename)}">Скачать ${esc(data.filename)}</a>` : ''}
        <p class="note">${(data.size / 1024).toFixed(1)} KiB${data.savedNatively ? ' · сохранено на устройство' : ''}${data.path ? ' · ' + esc(data.path) : ''}</p>
      `;
      setStatus('Сборка завершена', 'ok');
    } else {
      out.innerHTML = `
        <div class="log">${esc(log)}</div>
        <div class="issue error">${esc(data.error)}</div>
        ${data.projectZip ? `<p class="note">Проект сохранён: ${esc(data.projectZip)}</p>` : ''}
      `;
      setStatus('Сборка не удалась', 'err');
    }
  } catch (err) {
    out.innerHTML = `<div class="issue error">${esc(err.message)}</div>`;
    setStatus('Ошибка соединения', 'err');
  } finally {
    btn.disabled = false;
  }
}

/* -------------------------------------------------------------- prompt */

async function openPrompt() {
  $('promptModal').hidden = false;
  await loadPrompt();
}

async function loadPrompt() {
  const lang = $('promptLang').value;
  $('promptText').value = 'Загрузка…';
  $('promptText').value = await api.prompt(lang);
}

async function copyPrompt() {
  const text = $('promptText').value;
  try {
    await navigator.clipboard.writeText(text);
    $('copyPrompt').textContent = 'Скопировано';
  } catch {
    // Clipboard API needs a secure context; fall back to selection.
    $('promptText').select();
    document.execCommand('copy');
    $('copyPrompt').textContent = 'Скопировано';
  }
  setTimeout(() => { $('copyPrompt').textContent = 'Скопировать'; }, 1800);
}

/* ---------------------------------------------------------------- wire */

$('pick').onclick = async () => {
  // Inside a compiled app use the native picker when available.
  if (api && api.pickFile) {
    try {
      const picked = await api.pickFile();
      if (picked) {
        fileName = picked.name;
        fileBytes = picked.bytes;
        $('fileName').textContent = `${picked.name} · ${(picked.bytes.length / 1024).toFixed(1)} KiB`;
        $('buildBtn').disabled = false;
        permissionsTouched = false;
        await runInspect();
        return;
      }
    } catch (err) { setStatus(err.message, 'err'); }
  }
  $('file').click();
};
$('file').onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };

const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
};

for (const id of ['permInternet', 'permFiles']) {
  $(id).onchange = () => { permissionsTouched = true; };
}

$('target').onchange = updateTargetDesc;
$('buildBtn').onclick = runBuild;
$('promptBtn').onclick = openPrompt;
$('closePrompt').onclick = () => { $('promptModal').hidden = true; };
$('promptLang').onchange = loadPrompt;
$('copyPrompt').onclick = copyPrompt;
$('promptModal').onclick = (e) => { if (e.target === $('promptModal')) $('promptModal').hidden = true; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('promptModal').hidden = true;
});

async function boot() {
  api = await createApi();
  await loadTargets();
  await loadDoctor();
  const modeNote = api.mode === 'standalone'
    ? 'Компилятор запущен как приложение: доступны веб-бандл и исходный проект'
    : 'Готов к работе';
  setStatus(modeNote, 'ok');
  document.body.dataset.mode = api.mode;
}

boot().catch((err) => setStatus(err.message, 'err'));
