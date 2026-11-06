import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { appHome } from '../server.js';
import { serviceInfo, type ServiceInfo } from '../lock.js';
import { scrubbedEnv } from '../../platform/env.js';
import { activeCount, closeAction, confirmation, stopService, serviceEnded } from '../shell.js';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, Notification, Menu, shell, Tray, clipboard } = require('electron');
const smoke = process.env.CREWROOM_SMOKE;
if (smoke && !process.env.CREWROOM_HOME) throw new Error('冒烟模式必须设置 CREWROOM_HOME');
const home = appHome(), icon = fileURLToPath(new URL('../../../assets/icon.png', import.meta.url));
let win: any, tray: any, info: ServiceInfo | undefined, quitting = false, exiting = false, showing: Promise<void> | undefined;
let origin = '';
let serviceWatch: ReturnType<typeof setInterval> | undefined;
function followService() {
  if(serviceWatch) return;
  serviceWatch=setInterval(()=>{
    if(!info || exiting || quitting) return;
    let alive=true; try { process.kill(info.pid,0); } catch { alive=false; }
    if(serviceEnded(info,serviceInfo(home),alive)) {
      clearInterval(serviceWatch); quitting=true; tray?.destroy(); win?.destroy(); app.quit();
    }
  },1000);
}
const steps: Record<string, unknown> = {};
const headers = (value: ServiceInfo) => ({ Authorization: `Bearer ${value.token}`, Origin: `http://127.0.0.1:${value.port}` });
async function state(value: ServiceInfo) {
  const response = await fetch(`http://127.0.0.1:${value.port}/api/state`, { headers: headers(value), signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error(`服务返回 ${response.status}`);
  return response.json() as Promise<any>;
}
async function connect() {
  let current = serviceInfo(home);
  try { if (current) { await state(current); return current; } } catch {}
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: '1' } });
  let failure: Error | undefined; child.on('error', error => { failure = error; }); child.unref();
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    await new Promise(r => setTimeout(r, 100)); current = serviceInfo(home);
    try { if (current) { await state(current); return current; } } catch {}
  }
  throw new Error('无法连接服务，请检查服务是否能正常启动');
}
function trusted(event: any) { return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame?.url?.startsWith(origin + '/'); }
ipcMain.handle('choose-folder', async (event: any) => { if (!trusted(event)) return; const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('notify', (event: any, value: any) => { if (trusted(event) && typeof value?.title === 'string' && typeof value?.body === 'string') new Notification({ title: value.title.slice(0, 200), body: value.body.slice(0, 2000), icon }).show(); });
async function showWindow() {
  return showing ??= (async () => {
    const next = await connect(), changed = next.token !== info?.token || next.port !== info?.port; info = next; origin = `http://127.0.0.1:${next.port}`;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({ width: 1440, height: 940, icon, show: false, webPreferences: { preload: fileURLToPath(new URL('preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      win.on('close', (event: any) => { if (closeAction(quitting) === 'hide') { event.preventDefault(); win.hide(); } });
      // A window that refuses to close also refuses a Windows shutdown or sign-out.
      for (const name of ['query-session-end', 'session-end']) win.on(name, () => { quitting = true; });
      win.webContents.on('will-navigate', (event: any, url: string) => { try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
      win.webContents.setWindowOpenHandler(({ url }: { url: string }) => { try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {} return { action: 'deny' }; });
      await win.loadURL(`${origin}/?token=${next.token}`);
    } else if (changed) await win.loadURL(`${origin}/?token=${next.token}`);
    followService();
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
  })().finally(() => { showing = undefined; });
}
function reportError(error: unknown) { dialog.showErrorBox('无法启动 Crewroom', String(error)); }
async function exitApp() {
  if (exiting) return; exiting = true;
  try {
    if (showing) await showing.catch(() => {});
    const current = serviceInfo(home);
    if (current) {
      let count = 0; try { count = activeCount(await state(current)); } catch {}
      if (count && !smoke) {
        const result = await dialog.showMessageBox({ type: 'warning', ...confirmation(count), buttons: ['取消', '退出'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return;
      }
      const alive = () => { try { process.kill(current.pid, 0); return true; } catch { return false; } };
      const outcome = await stopService(current, {
        request: async signal => { const r = await fetch(`http://127.0.0.1:${current.port}/api/shutdown`, { method: 'POST', headers: headers(current), signal }); if (!r.ok) throw new Error(`退出失败 ${r.status}`); },
        alive, same: () => { const next = serviceInfo(home); return next ? next.pid === current.pid && next.token === current.token : undefined; }, kill: pid => { try { process.kill(pid); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } },
      });
      steps.shutdown = outcome;
    } else steps.shutdown = 'absent';
    quitting = true; tray?.destroy(); steps.trayDestroyed = !tray || tray.isDestroyed();
    if (smoke) {
      const ok = ['connected', 'trayCreated', 'windowLoaded', 'clipboardCopy', 'clipboardShortcuts', 'windowHidden', 'appAlive', 'serviceAlive', 'trayDestroyed'].every(key => steps[key] === true) && ['stopped', 'absent'].includes(String(steps.shutdown)) && !steps.error;
      writeFileSync(smoke, JSON.stringify({ ...steps, ok }, null, 2));
      if (!ok) { app.exit(1); return; }
    }
    app.quit();
  } catch (error) { if (smoke) { writeFileSync(smoke, JSON.stringify({ ...steps, ok: false, error: String(error) })); quitting = true; app.exit(1); } else reportError(error); }
  finally { exiting = false; }
}
app.setAppUserModelId('Crewroom.Workbench');
// Isolate Electron's own single-instance lock and browser storage for smoke runs too.
app.setPath('userData', resolve(home, 'electron'));
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  app.on('second-instance', () => { if (!exiting) void app.whenReady().then(showWindow).catch(reportError); });
  app.on('before-quit', (event: any) => { if (!quitting) event.preventDefault(); });
  app.on('window-all-closed', () => {});
  // Electron ESM must finish evaluating before ready can fire.
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    tray = new Tray(icon); tray.setToolTip('Crewroom');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Crewroom', click: () => { if (!exiting) void showWindow().catch(reportError); } }, { label: '退出（停止所有会话）', click: () => { void exitApp(); } }]));
    for (const event of ['click', 'double-click']) tray.on(event, () => { if (!exiting) void showWindow().catch(reportError); });
    await showWindow();
    if (smoke) {
      steps.connected = !!info; steps.trayCreated = !tray.isDestroyed(); steps.windowLoaded = await win.webContents.executeJavaScript('document.readyState') === 'complete';
      // Electron's clipboard API is asynchronous. Put back what the user had; only text can be restored.
      const savedClipboard = await clipboard.readText();
      await win.webContents.executeJavaScript(`const input = document.createElement('input'); input.id = 'agents-smoke-input'; document.body.append(input); input.value = 'Crewroom 复制粘贴'; input.focus(); input.select();`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
      await new Promise(r => setTimeout(r, 150));
      steps.clipboardCopy = await clipboard.readText() === 'Crewroom 复制粘贴';
      await win.webContents.executeJavaScript(`document.getElementById('agents-smoke-input').value = ''`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      await new Promise(r => setTimeout(r, 150));
      steps.clipboardShortcuts = await win.webContents.executeJavaScript(`document.getElementById('agents-smoke-input').value === 'Crewroom 复制粘贴'`);
      await clipboard.writeText(savedClipboard);
      win.close(); steps.windowHidden = !win.isVisible() && !win.isDestroyed(); steps.appAlive = true; steps.serviceAlive = !!info && !!await state(info);
      await exitApp();
    }
  }).catch(async (error: unknown) => {
    // A failed smoke run still goes through the exit flow, so it leaves no service behind.
    if (smoke) { steps.error = String(error); await exitApp(); }
    else reportError(error);
    quitting = true; tray?.destroy(); app.exit(1);
  });
}
