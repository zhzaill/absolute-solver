// Desktop-pet host for the /figure projection.
//
// Transparent, frameless, always-on-top, click-through by default: the character
// floats over the desktop and the mouse passes straight through to whatever is
// behind it. Ctrl+Shift+F toggles interaction (then the body is a drag handle),
// Esc closes the window.
const { app, BrowserWindow, globalShortcut, screen } = require('electron');

if (!app) {
  console.error('This file must run under Electron, not Node. Use: node tools/face-window.mjs');
  process.exit(1);
}

const FACE_URL = process.env.FACE_URL || 'http://127.0.0.1:18111/figure';
const WIDTH = Number(process.env.FACE_WIDTH || 420);
const HEIGHT = Number(process.env.FACE_HEIGHT || 760);

let win = null;
let interactive = false;

function placeBottomRight() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - WIDTH - 24),
    y: Math.round(workArea.y + workArea.height - HEIGHT),
  };
}

function setInteractive(value) {
  interactive = value;
  if (!win) return;
  // forward:true keeps mousemove flowing to the page while clicks pass through.
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}

function createWindow() {
  const { x, y } = placeBottomRight();
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(FACE_URL);

  win.webContents.on('did-fail-load', () => {
    // The projection server is not up yet; retry shortly instead of showing a blank window.
    setTimeout(() => { try { win.loadURL(FACE_URL); } catch { /* ignore */ } }, 2000);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+F', () => setInteractive(!interactive));
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
