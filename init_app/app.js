/*
 * app.js — логіка пульта init_stm: інтерфейс і команди плати.
 * Bluetooth — в ble.js (BleLink), тут від нього потрібні лише connect / send / onLine.
 *
 * Протокол плати (режим налаштування):
 *   GET          -> MODE=BOTH, TAP=1500, MAG=30, RED=1000, TIM=20, SAVED=YES|NO
 *   MODE x       -> OK MODE=x      (ACC | MAG | BOTH)
 *   TAP/MAG/RED/TIM n -> OK TAP=n  або  ERR мін-макс
 *   SAVE         -> OK SAVED, OK RUN  (далі плата йде в роботу і вимикає BLE)
 *   RUN          -> OK RUN, NOT SAVED (вихід без збереження)
 *   DEFAULT      -> OK DEFAULT
 *   Сама плата пише: INIT_STM READY, TIMEOUT, NOT SAVED, LEVER UP, NOT SAVED, AT+VER (службове)
 */

// ---------- межі параметрів (як у прошивці) ----------
const PARAMS = {
  TAP: { min: 50,  max: 20000, log: true  },
  MAG: { min: 5,   max: 2000,  log: true  },
  RED: { min: 100, max: 10000, log: true  },
  TIM: { min: 0,   max: 300,   log: false },
};
const KEYS = ['MODE', 'TAP', 'MAG', 'RED', 'TIM'];
const REPLY_TIMEOUT_MS = 2500;

// ---------- стан ----------
const board = {};          // що зараз на платі (з останнього GET / OK)
const edit  = {};          // що виставлено в інтерфейсі
let boardSaved = null;     // SAVED=YES/NO з плати
let waiter = null;         // очікування відповіді на команду
let queue  = Promise.resolve();
let busy   = false;

// ---------- елементи ----------
const $ = sel => document.querySelector(sel);
const el = {
  status: $('#status'), connect: $('#btnConnect'), connectAll: $('#btnConnectAll'),
  hint: $('#hint'), noBle: $('#noBle'), toast: $('#toast'),
  settings: $('#settings'), savedFlag: $('#savedFlag'), mode: $('#mode'),
  save: $('#btnSave'), get: $('#btnGet'), def: $('#btnDefault'), run: $('#btnRun'),
  log: $('#log'), showService: $('#showService'), clear: $('#btnClear'),
  rawForm: $('#rawForm'), rawInput: $('#rawInput'),
};

// =====================================================================
// Повзунки: логарифмічна шкала для великих діапазонів (50..20000 мг)
// =====================================================================
function posToValue(key, pos) {
  const p = PARAMS[key];
  let v = p.log ? p.min * Math.pow(p.max / p.min, pos / 1000) : p.min + (p.max - p.min) * pos / 1000;
  return niceRound(v, p);
}
function valueToPos(key, v) {
  const p = PARAMS[key];
  v = Math.min(p.max, Math.max(p.min, v));
  return p.log ? Math.round(1000 * Math.log(v / p.min) / Math.log(p.max / p.min))
               : Math.round(1000 * (v - p.min) / (p.max - p.min));
}
function niceRound(v, p) {
  const step = v >= 5000 ? 100 : v >= 1000 ? 50 : v >= 200 ? 10 : v >= 50 ? 5 : 1;
  v = Math.round(v / step) * step;
  return Math.min(p.max, Math.max(p.min, v));
}

function fieldOf(key) { return document.querySelector(`.field[data-key="${key}"]`); }

function setEdit(key, value, fromSlider) {
  edit[key] = value;
  if (key === 'MODE') {
    el.mode.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === value));
  } else {
    const f = fieldOf(key);
    f.querySelector('input[type=number]').value = value;
    if (!fromSlider) f.querySelector('input[type=range]').value = valueToPos(key, value);
  }
  refreshChanged();
}

function changedKeys() {
  return KEYS.filter(k => edit[k] !== undefined && board[k] !== undefined && String(edit[k]) !== String(board[k]));
}

function refreshChanged() {
  const ch = changedKeys();
  Object.keys(PARAMS).forEach(k => fieldOf(k).classList.toggle('changed', ch.includes(k)));
  if (boardSaved === null) { el.savedFlag.textContent = ''; el.savedFlag.className = 'tag'; return; }
  const dirty = ch.length > 0 || boardSaved === false;
  el.savedFlag.textContent = dirty ? 'не збережено' : 'збережено';
  el.savedFlag.className = 'tag ' + (dirty ? 'dirty' : 'clean');
}

// Прив'язка полів
Object.keys(PARAMS).forEach(key => {
  const f = fieldOf(key);
  const num = f.querySelector('input[type=number]');
  const rng = f.querySelector('input[type=range]');
  num.min = PARAMS[key].min;
  num.max = PARAMS[key].max;
  rng.addEventListener('input', () => setEdit(key, posToValue(key, +rng.value), true));
  num.addEventListener('change', () => {
    let v = parseInt(num.value, 10);
    if (isNaN(v)) v = board[key] ?? PARAMS[key].min;
    v = Math.min(PARAMS[key].max, Math.max(PARAMS[key].min, v));
    setEdit(key, v, false);
  });
});
el.mode.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setEdit('MODE', b.dataset.mode)));

// =====================================================================
// Журнал і повідомлення
// =====================================================================
function log(text, cls) {
  const d = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  d.textContent = `${t} ${cls === 'tx' ? '→' : cls === 'sys' ? '•' : '←'} ${text}`;
  d.className = cls || '';
  if (cls === 'svc' && !el.showService.checked) d.hidden = true;
  el.log.appendChild(d);
  while (el.log.children.length > 400) el.log.removeChild(el.log.firstChild);
  el.log.scrollTop = el.log.scrollHeight;
}
el.showService.addEventListener('change', () => {
  el.log.querySelectorAll('.svc').forEach(d => { d.hidden = !el.showService.checked; });
});
el.clear.addEventListener('click', () => { el.log.innerHTML = ''; });

let toastTimer = null;
function toast(text, kind = 'info', ms = 5000) {
  el.toast.textContent = text;
  el.toast.className = 'toast ' + kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

// =====================================================================
// Стан з'єднання
// =====================================================================
function setConnState(state, name) {
  const on = state === 'connected';
  el.status.textContent = on ? `Підключено${name ? ' · ' + name : ''}`
                        : state === 'connecting' ? 'Підключення…' : 'Не підключено';
  el.status.className = 'pill ' + (on ? 'on' : state === 'connecting' ? 'busy' : 'off');
  el.connect.textContent = on ? 'Відключити' : 'Підключити';
  el.connect.disabled = state === 'connecting';
  el.connectAll.hidden = on;
  el.hint.hidden = on;
  setControlsEnabled(on && !busy);
  if (state === 'disconnected') {
    if (waiter) { waiter.reject(new Error('з\'єднання розірвано')); waiter = null; }
    log('з\'єднання закрито', 'sys');
  }
}

function setControlsEnabled(on) {
  el.settings.classList.toggle('disabled', !on);
  [el.save, el.get, el.def, el.run].forEach(b => { b.disabled = !on; });
  el.rawForm.querySelector('button').disabled = !BleLink.connected;
}

// =====================================================================
// Прийом рядків від плати
// =====================================================================
function parseKv(line) {
  const s = line.startsWith('OK ') ? line.slice(3) : line;
  const m = /^(MODE|TAP|MAG|RED|TIM|SAVED)=(\S+)$/.exec(s);
  if (!m) return null;
  return { key: m[1], value: m[1] === 'MODE' || m[1] === 'SAVED' ? m[2] : parseInt(m[2], 10) };
}

BleLink.onLine = line => {
  if (line.startsWith('AT+')) { log(line, 'svc'); return; }   // службова перевірка плати
  log(line);

  const kv = parseKv(line);
  if (kv) {
    if (kv.key === 'SAVED') boardSaved = kv.value === 'YES';
    else {
      board[kv.key] = kv.value;
      setEdit(kv.key, kv.value);                                // інтерфейс = плата
    }
    refreshChanged();
  }

  if (line === 'INIT_STM READY') setTimeout(() => refresh(), 300);
  if (line === 'TIMEOUT, NOT SAVED')  toast('Плата вийшла з налаштування: 2 хв без команд. Зміни не збережено.', 'err', 0);
  if (line === 'LEVER UP, NOT SAVED') toast('Важіль піднято: плата пішла в таймер. Зміни не збережено.', 'err', 0);

  if (waiter && waiter.match(line)) { waiter.resolve(line); waiter = null; }
};

BleLink.onState = (state, name) => setConnState(state, name);

// =====================================================================
// Команди: по одній, кожна чекає свою відповідь
// =====================================================================
function command(text, match) {
  const job = queue.then(() => new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiter) { waiter = null; reject(new Error(`плата не відповіла на ${text}`)); }
    }, REPLY_TIMEOUT_MS);
    waiter = {
      match,
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e); },
    };
    try {
      log(text, 'tx');
      await BleLink.send(text + '\r\n');
    } catch (e) {
      clearTimeout(timer); waiter = null; reject(e);
    }
  }));
  queue = job.catch(() => {});
  return job;
}
const okOrErr = l => l.startsWith('OK') || l.startsWith('ERR');

async function withBusy(fn) {
  if (busy) return;
  busy = true; setControlsEnabled(false);
  try { await fn(); }
  catch (e) { toast('Помилка: ' + e.message, 'err'); log(e.message, 'sys'); }
  finally { busy = false; setControlsEnabled(BleLink.connected); }
}

function refresh() {
  return withBusy(async () => {
    await command('GET', l => l.startsWith('SAVED='));
  });
}

// Надіслати змінені значення на плату (без збереження)
async function sendChanges() {
  for (const k of changedKeys()) {
    const reply = await command(`${k} ${edit[k]}`, okOrErr);
    if (reply.startsWith('ERR')) throw new Error(`${k}: плата відповіла ${reply}`);
  }
}

// =====================================================================
// Кнопки
// =====================================================================
el.connect.addEventListener('click', () => doConnect(false));
el.connectAll.addEventListener('click', () => doConnect(true));

async function doConnect(showAll) {
  if (BleLink.connected) { await BleLink.disconnect(); return; }
  try {
    Object.keys(board).forEach(k => delete board[k]);
    boardSaved = null;
    await BleLink.connect(showAll);
    toast('Підключено. Читаю налаштування…', 'ok', 2500);
    setTimeout(() => { if (boardSaved === null) refresh(); }, 1200);   // якщо привітання не прийшло
  } catch (e) {
    setConnState('disconnected');
    if (e.name !== 'NotFoundError') toast('Не вдалося підключитись: ' + e.message, 'err');
  }
}

el.get.addEventListener('click', () => refresh());

el.save.addEventListener('click', () => withBusy(async () => {
  await sendChanges();
  const r = await command('SAVE', l => l === 'OK RUN' || l.startsWith('ERR'));
  if (r.startsWith('ERR')) throw new Error('плата не змогла зберегти (' + r + ')');
  toast('Збережено. Плата перейшла в роботу.', 'ok', 0);
}));

el.run.addEventListener('click', () => withBusy(async () => {
  if (!confirm('Вийти без збереження? Зміни буде скасовано.')) return;
  await command('RUN', l => l.startsWith('OK RUN') || l.startsWith('ERR'));
  toast('Вихід без збереження. Плата перейшла в роботу.', 'info', 0);
}));

el.def.addEventListener('click', () => withBusy(async () => {
  if (!confirm('Повернути заводські значення? Вони запишуться лише після «Зберегти».')) return;
  await command('DEFAULT', okOrErr);
  await command('GET', l => l.startsWith('SAVED='));
}));

el.rawForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const text = el.rawInput.value.trim();
  if (!text) return;
  el.rawInput.value = '';
  try { await BleLink.send(text + '\r\n'); log(text, 'tx'); }
  catch (e) { toast('Помилка: ' + e.message, 'err'); }
});

// =====================================================================
// Старт
// =====================================================================
Object.keys(PARAMS).forEach(k => { fieldOf(k).querySelector('input[type=range]').value = 0; });
setConnState('idle');
if (!BleLink.available()) {
  el.noBle.hidden = false;
  el.connect.disabled = true;
  el.connectAll.hidden = true;
}
