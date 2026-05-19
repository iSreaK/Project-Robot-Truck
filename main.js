// Processus principal Electron.
// Rôle : gérer la fenêtre + la communication série (USB ou Bluetooth-SPP, qui
// apparaît aussi comme un COM sous Windows). Le renderer n'a pas accès direct
// au port série pour des raisons de sécurité — il dialogue par IPC.

'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { SerialPort } = require('serialport');

let mainWindow = null;
let currentPort = null; // instance SerialPort active

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0f1218',
    title: 'mBot Ranger Control',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  await safeClosePort();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// Helpers série
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function safeClosePort() {
  if (currentPort && currentPort.isOpen) {
    await new Promise((resolve) => currentPort.close(() => resolve()));
  }
  currentPort = null;
}

// ---------------------------------------------------------------------------
// IPC : lister les ports série
// ---------------------------------------------------------------------------

ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    // On ne garde que les champs utiles pour le rendu.
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      friendlyName: p.friendlyName || '',
      pnpId: p.pnpId || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    }));
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
});

// ---------------------------------------------------------------------------
// IPC : ouvrir un port
// ---------------------------------------------------------------------------

ipcMain.handle('serial:open', async (_evt, { path: portPath, baudRate }) => {
  await safeClosePort();
  return await new Promise((resolve) => {
    try {
      const port = new SerialPort(
        {
          path: portPath,
          baudRate: baudRate || 115200,
          dataBits: 8,
          parity: 'none',
          stopBits: 1,
          autoOpen: false,
        },
        (err) => {
          if (err) {
            resolve({ ok: false, error: String(err.message || err) });
          }
        }
      );

      port.open((err) => {
        if (err) {
          resolve({ ok: false, error: String(err.message || err) });
          return;
        }
        currentPort = port;

        port.on('data', (chunk) => {
          // Le renderer reçoit le buffer brut, le parser y vit côté UI.
          send('serial:data', Array.from(chunk));
        });

        port.on('error', (e) => {
          send('serial:error', String(e && e.message ? e.message : e));
        });

        port.on('close', () => {
          send('serial:closed', null);
          currentPort = null;
        });

        resolve({ ok: true, path: portPath });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
});

// ---------------------------------------------------------------------------
// IPC : fermer le port
// ---------------------------------------------------------------------------

ipcMain.handle('serial:close', async () => {
  await safeClosePort();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC : envoyer une trame brute (côté renderer on construit le protocole)
// ---------------------------------------------------------------------------

ipcMain.handle('serial:write', async (_evt, bytes) => {
  if (!currentPort || !currentPort.isOpen) {
    return { ok: false, error: 'Port non ouvert' };
  }
  const buf = Buffer.from(bytes);
  return await new Promise((resolve) => {
    currentPort.write(buf, (err) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err) });
      } else {
        resolve({ ok: true });
      }
    });
  });
});
