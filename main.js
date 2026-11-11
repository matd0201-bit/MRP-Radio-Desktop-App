'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');

const APP_TITLE = 'MISHAP RP RADIO';
const APP_ICON = path.join(__dirname, 'assets', 'mishap-radio.png');
const HTML_FILE = path.join(__dirname, 'index.html');

let mainWindow = null;
let keyboardHook = null;
let pttConfig = null;
let pttPressed = false;
let hookStatus = { ok: false, message: 'Initialisation du raccourci global…' };

// Profil stable : les réglages radio restent conservés entre deux lancements
// et entre deux versions du EXE portable.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'MISHAP RP RADIO'));
} catch (error) {
  console.warn('[MISHAP] Profil utilisateur :', error);
}

// Mapping des KeyboardEvent.code du navigateur vers les codes physiques
// utilisés par libuiohook / uiohook-napi. Les lettres suivent la position
// physique de la touche (KeyA, KeyZ, etc.), indépendamment de la langue du clavier.
const KEY_CODES = {
  Escape: 0x0001,
  Digit1: 0x0002, Digit2: 0x0003, Digit3: 0x0004, Digit4: 0x0005,
  Digit5: 0x0006, Digit6: 0x0007, Digit7: 0x0008, Digit8: 0x0009,
  Digit9: 0x000a, Digit0: 0x000b,
  Minus: 0x000c, Equal: 0x000d, Backspace: 0x000e, Tab: 0x000f,
  KeyQ: 0x0010, KeyW: 0x0011, KeyE: 0x0012, KeyR: 0x0013,
  KeyT: 0x0014, KeyY: 0x0015, KeyU: 0x0016, KeyI: 0x0017,
  KeyO: 0x0018, KeyP: 0x0019, BracketLeft: 0x001a, BracketRight: 0x001b,
  Enter: 0x001c, ControlLeft: 0x001d, KeyA: 0x001e, KeyS: 0x001f,
  KeyD: 0x0020, KeyF: 0x0021, KeyG: 0x0022, KeyH: 0x0023,
  KeyJ: 0x0024, KeyK: 0x0025, KeyL: 0x0026, Semicolon: 0x0027,
  Quote: 0x0028, Backquote: 0x0029, ShiftLeft: 0x002a,
  Backslash: 0x002b, KeyZ: 0x002c, KeyX: 0x002d, KeyC: 0x002e,
  KeyV: 0x002f, KeyB: 0x0030, KeyN: 0x0031, KeyM: 0x0032,
  Comma: 0x0033, Period: 0x0034, Slash: 0x0035, ShiftRight: 0x0036,
  NumpadMultiply: 0x0037, AltLeft: 0x0038, Space: 0x0039, CapsLock: 0x003a,
  F1: 0x003b, F2: 0x003c, F3: 0x003d, F4: 0x003e, F5: 0x003f,
  F6: 0x0040, F7: 0x0041, F8: 0x0042, F9: 0x0043, F10: 0x0044,
  NumLock: 0x0045, ScrollLock: 0x0046,
  Numpad7: 0x0047, Numpad8: 0x0048, Numpad9: 0x0049,
  NumpadSubtract: 0x004a, Numpad4: 0x004b, Numpad5: 0x004c,
  Numpad6: 0x004d, NumpadAdd: 0x004e, Numpad1: 0x004f,
  Numpad2: 0x0050, Numpad3: 0x0051, Numpad0: 0x0052,
  NumpadDecimal: 0x0053, F11: 0x0057, F12: 0x0058,
  F13: 0x005b, F14: 0x005c, F15: 0x005d, F16: 0x0063,
  F17: 0x0064, F18: 0x0065, F19: 0x0066, F20: 0x0067,
  F21: 0x0068, F22: 0x0069, F23: 0x006a, F24: 0x006b,
  PrintScreen: 0x0e37, Pause: 0x0e45,
  Insert: 0x0e52, Delete: 0x0e53, Home: 0x0e47, End: 0x0e4f,
  PageUp: 0x0e49, PageDown: 0x0e51,
  ArrowUp: 0xe048, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, ArrowDown: 0xe050,
  ControlRight: 0x0e1d, AltRight: 0x0e38,
  MetaLeft: 0x0e5b, MetaRight: 0x0e5c,
  NumpadDivide: 0x0e35, NumpadEnter: 0x0e1c,
  IntlBackslash: 0x0e46
};

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'
]);

function cleanPttConfig(input) {
  if (!input || typeof input !== 'object' || !input.key || typeof input.key !== 'object') {
    return null;
  }
  const code = String(input.key.code || '');
  if (!Object.prototype.hasOwnProperty.call(KEY_CODES, code)) return null;
  return {
    code,
    keycode: KEY_CODES[code],
    ctrl: !!input.key.ctrl,
    shift: !!input.key.shift,
    alt: !!input.key.alt,
    meta: !!input.key.meta,
    mode: input.mode === 'toggle' ? 'toggle' : 'hold'
  };
}

function modifiersMatch(event, binding) {
  if (MODIFIER_CODES.has(binding.code)) return true;
  return !!event.ctrlKey === binding.ctrl &&
    !!event.shiftKey === binding.shift &&
    !!event.altKey === binding.alt &&
    !!event.metaKey === binding.meta;
}

function sendGlobalPtt(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:global-ptt', state);
}

function releaseGlobalPtt() {
  if (!pttPressed) return;
  pttPressed = false;
  sendGlobalPtt('up');
}

function onGlobalKeyDown(event) {
  if (!pttConfig || !mainWindow || mainWindow.isDestroyed()) return;
  // Quand la radio est au premier plan, le clavier est géré par la page elle-même.
  if (mainWindow.isFocused()) return;
  if (event.keycode !== pttConfig.keycode) return;
  if (!modifiersMatch(event, pttConfig) || pttPressed) return;

  pttPressed = true;
  sendGlobalPtt('down');
}

function onGlobalKeyUp(event) {
  if (!pttPressed || !pttConfig) return;
  if (event.keycode === pttConfig.keycode) releaseGlobalPtt();
}

function startKeyboardHook() {
  try {
    const { uIOhook } = require('uiohook-napi');
    if (!uIOhook || typeof uIOhook.on !== 'function' || typeof uIOhook.start !== 'function') {
      throw new Error('Le module de raccourci clavier global est incomplet.');
    }
    keyboardHook = uIOhook;
    keyboardHook.on('keydown', onGlobalKeyDown);
    keyboardHook.on('keyup', onGlobalKeyUp);
    keyboardHook.start();
    hookStatus = { ok: true, message: 'Raccourci PTT global actif.' };
  } catch (error) {
    hookStatus = {
      ok: false,
      message: 'PTT en arrière-plan indisponible : ' + String(error && error.message || error)
    };
    console.error('[MISHAP] Impossible de démarrer le PTT global :', error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 940,
    minHeight: 680,
    title: APP_TITLE,
    backgroundColor: '#0a0c0f',
    autoHideMenuBar: true,
    show: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('desktop:ptt-status', hookStatus);
  });

  mainWindow.on('focus', () => {
    // Sécurité : si la fenêtre reprend le focus pendant une pression globale,
    // on force le relâchement pour éviter une transmission bloquée.
    releaseGlobalPtt();
  });

  mainWindow.on('blur', () => {
    // Le renderer gère son relâchement normal. Le hook prend le relais
    // quand une nouvelle pression PTT survient hors de la fenêtre.
  });

  mainWindow.on('closed', () => {
    releaseGlobalPtt();
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `file://${HTML_FILE.replace(/\\/g, '/')}` && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(HTML_FILE);
}

ipcMain.on('desktop:ptt-config', (_event, config) => {
  const next = cleanPttConfig(config);
  const changed = JSON.stringify(next) !== JSON.stringify(pttConfig);
  if (changed) releaseGlobalPtt();
  pttConfig = next;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('fr.mishaprp.radio');

    // La radio ne demande que l'accès au microphone audio, pas à la caméra.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (permission === 'media' && details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('audio')) {
        callback(true);
        return;
      }
      callback(false);
    });

    startKeyboardHook();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  releaseGlobalPtt();
  try {
    if (keyboardHook && typeof keyboardHook.stop === 'function') keyboardHook.stop();
  } catch (error) {
    console.warn('[MISHAP] Arrêt du hook clavier :', error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
