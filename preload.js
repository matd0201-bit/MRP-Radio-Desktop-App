'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// API minimale exposée à la page radio. Aucun accès Node.js n'est donné au HTML.
contextBridge.exposeInMainWorld('mishapDesktop', {
  setPttConfig(config) {
    ipcRenderer.send('desktop:ptt-config', config);
  },
  onPttStatus(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('desktop:ptt-status', (_event, status) => callback(status));
  }
});

// Réutilise le pont PTT déjà présent dans l'interface : il gère correctement
// le relâchement du micro quand la fenêtre est en arrière-plan.
ipcRenderer.on('desktop:global-ptt', (_event, state) => {
  if (state !== 'down' && state !== 'up') return;
  window.dispatchEvent(new CustomEvent('mishap-radio-extension-ptt', { detail: state }));
});
