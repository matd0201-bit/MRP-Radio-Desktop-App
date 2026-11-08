// MISHAP RP RADIO - coquille Electron
// Rôle : afficher index.html + relayer les touches clavier GLOBALES (fenêtre en arrière-plan)
// vers la page, sous forme d'évènements clavier identiques à ceux d'une vraie frappe.
const { app, BrowserWindow, session, powerSaveBlocker, shell } = require('electron');
const path = require('path');

let uio = null;
try { uio = require('uiohook-napi'); } catch (e) { console.error('uiohook-napi indisponible :', e); }

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let psb = null;
let bound = new Set(['Space']);   // codes de touches assignés dans la page
const forwarded = new Set();      // touches dont le "keydown" a été relayé (pour relayer aussi le "keyup")

// ----- Correspondance code DOM (KeyboardEvent.code) <-> keycode uiohook -----
const byKeycode = {};
function buildMap() {
  if (!uio) return;
  const K = uio.UiohookKey, map = {};
  const add = (code, name) => { if (K[name] !== undefined) map[code] = K[name]; };
  for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); add('Key' + L, L); }
  for (let d = 0; d <= 9; d++) { add('Digit' + d, d); add('Numpad' + d, 'Numpad' + d); }
  for (let f = 1; f <= 24; f++) add('F' + f, 'F' + f);
  ['Space','Enter','Tab','Escape','Backspace','Backquote','Minus','Equal','BracketLeft','BracketRight',
   'Semicolon','Quote','Backslash','Comma','Period','Slash','CapsLock','ArrowUp','ArrowDown','ArrowLeft',
   'ArrowRight','Insert','Delete','Home','End','PageUp','PageDown','NumpadEnter','NumpadAdd',
   'NumpadSubtract','NumpadMultiply','NumpadDivide','NumpadDecimal'].forEach(n => add(n, n));
  add('ControlLeft', 'Ctrl'); add('ControlRight', 'CtrlRight');
  add('ShiftLeft', 'Shift');  add('ShiftRight', 'ShiftRight');
  add('AltLeft', 'Alt');      add('AltRight', 'AltRight');
  add('MetaLeft', 'Meta');    add('MetaRight', 'MetaRight');
  Object.keys(map).forEach(code => { byKeycode[map[code]] = code; });
}

function sendKey(type, code, e, repeat) {
  if (!win || win.isDestroyed()) return;
  const o = { code, key: code, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey,
              metaKey: !!e.metaKey, repeat: !!repeat, bubbles: true, cancelable: true };
  win.webContents
    .executeJavaScript('document.dispatchEvent(new KeyboardEvent(' + JSON.stringify(type) + ',' + JSON.stringify(o) + '))')
    .catch(() => {});
}

function startHook() {
  if (!uio) return;
  buildMap();
  uio.uIOhook.on('keydown', e => {
    const code = byKeycode[e.keycode];
    if (!code || !bound.has(code)) return;
    const was = forwarded.has(code);
    // Fenêtre au premier plan : la page gère elle-même le clavier
    if (!was && win && !win.isDestroyed() && win.isFocused()) return;
    forwarded.add(code);
    sendKey('keydown', code, e, was);
  });
  uio.uIOhook.on('keyup', e => {
    const code = byKeycode[e.keycode];
    if (!code || !forwarded.has(code)) return;
    forwarded.delete(code);
    sendKey('keyup', code, e, false);
  });
  try { uio.uIOhook.start(); } catch (e) { console.error('Hook clavier non démarré :', e); }
}

// Relit les touches configurées dans la page (Paramètres > Raccourcis clavier)
function refreshBindings() {
  if (!win || win.isDestroyed()) return;
  const js = '(function(){try{var j=JSON.parse(localStorage.getItem("mishapRadio")||"null");' +
    'if(!j)return ["Space"];return Object.keys(j.keys||{}).map(function(a){return j.keys[a]&&j.keys[a].code}).filter(Boolean)}' +
    'catch(e){return ["Space"]}})()';
  win.webContents.executeJavaScript(js).then(list => {
    if (Array.isArray(list)) bound = new Set(list.map(String));
  }).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 900, minWidth: 380, minHeight: 600,
    backgroundColor: '#0a0c0f', title: 'MISHAP RP RADIO', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'speaker-selection'));
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'speaker-selection');
  psb = powerSaveBlocker.start('prevent-app-suspension');
  createWindow();
  startHook();
  setInterval(refreshBindings, 1000);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { if (uio) uio.uIOhook.stop(); } catch (e) {}
  try { if (psb !== null) powerSaveBlocker.stop(psb); } catch (e) {}
});
