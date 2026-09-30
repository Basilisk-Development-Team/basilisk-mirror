/* Cookie clearing, shutdown persistence and new-tab menu regression fixture. */
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource:///modules/ContentStorage.jsm');
Components.utils.import('resource:///modules/Sanitizer.jsm');
function check(value, label) { if (!value) throw Error(label); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(test, label) {
  for (let i = 0; i < 300; ++i) { if (await test()) return; await delay(100); }
  throw Error(label);
}
function finish(error) {
  dump('CONTENT-TEST ' + (error ? 'FAIL ' + error + '\n' + error.stack : 'PASS all') + '\n');
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
window.addEventListener('load', () => run().then(() => finish(), finish));
async function run() {
  const base = 'http://127.0.0.1:' + Services.prefs.getIntPref('content.test.port');
  const phase = Services.prefs.getCharPref('content.test.phase');
  ContentStorage.init();
  if (phase == 'dormant-clear') {
    // No browser window or content view has been created in this process.
    await ContentStorage.clearCookies();
    dump('CONTENT-TEST PASS clear dormant persistent stores without a view\n');
    return;
  }
  const win = window.openDialog('chrome://browser/content/browser.xul', '_blank', 'chrome,all,dialog=no', 'about:blank');
  await waitFor(() => win.gBrowserInit && win.gBrowserInit.delayedStartupFinished, 'startup');
  const apis = [];
  for (const id of [0, 1, 2]) {
    const tab = win.ContentEngines.open(base + '/cookies', true, true, 'webkit', id);
    await waitFor(() => tab.linkedBrowser.contentTitle == 'Content fixture' && !tab.hasAttribute('busy'), 'load');
    apis.push(tab.linkedBrowser.contentAPI);
  }
  async function verifyEmpty() {
    for (const api of apis) check(await api.executeScript('return document.cookie;') === '', 'cookies survived ' + phase);
  }
  async function seed() {
    for (const api of apis) {
      await api.executeScript("document.cookie='persist=yes;path=/;max-age=86400'; localStorage.setItem('keep','yes');");
      check(await api.executeScript('return document.cookie;') === 'persist=yes', 'cookie was not set');
    }
  }
  await verifyEmpty();
  if (phase != 'seed') {
    for (const api of apis) check(await api.executeScript("return localStorage.getItem('keep');") === 'yes', 'cookie clear removed localStorage');
  }
  if (phase == 'sanitize-read') return;
  if (phase == 'lifetime-read') {
    Services.prefs.setIntPref('network.cookie.lifetimePolicy', 0);
    Services.prefs.setBoolPref('privacy.sanitize.sanitizeOnShutdown', true);
    Services.prefs.setBoolPref('privacy.clearOnShutdown.cookies', true);
    for (const item of ['history', 'formdata', 'downloads', 'cache', 'sessions', 'offlineApps', 'siteSettings', 'openWindows']) {
      Services.prefs.setBoolPref('privacy.clearOnShutdown.' + item, false);
    }
    await seed();
    return;
  }
  await seed();
  if (phase == 'seed') return;
  const item = win.document.getElementById('new-tab-button-newwebkit');
  check(item && item.parentNode.id == 'new-tab-button-popup', 'missing new-tab context item');
  item.doCommand();
  check(win.SessionStore.getTabValue(win.gBrowser.selectedTab, 'basilisk.engineOverride') === 'webkit', 'menu did not select WebKit');
  check(win.document.activeElement === win.gURLBar.inputField, 'menu did not focus location bar');
  win.gBrowser.selectedBrowser.loadURI(base + '/cookies-newtab');
  await waitFor(() => win.ContentEngines.get() &&
    win.gBrowser.selectedBrowser.contentTitle == 'Content fixture' &&
    !win.gBrowser.selectedTab.hasAttribute('busy'), 'menu tab did not navigate with WebKit');
  const privateWin = window.openDialog('chrome://browser/content/browser.xul', '_blank',
    'chrome,all,dialog=no,private', 'about:blank');
  await waitFor(() => privateWin.gBrowserInit && privateWin.gBrowserInit.delayedStartupFinished, 'private startup');
  const privateTab = privateWin.ContentEngines.open(base + '/cookies', true, true, 'webkit', 1);
  await waitFor(() => privateTab.linkedBrowser.contentTitle == 'Content fixture' && !privateTab.hasAttribute('busy'), 'private load');
  const privateAPI = privateTab.linkedBrowser.contentAPI;
  check(await privateAPI.executeScript('return document.cookie;') === '', 'private cookie leak');
  apis.push(privateAPI);
  await seed();
  const cookieWindow = window.openDialog('chrome://browser/content/preferences/cookies.xul',
    '_blank', 'chrome,dialog=no');
  await waitFor(() => cookieWindow.gCookiesWindow && cookieWindow.gCookiesWindow._tree, 'cookie manager startup');
  const removeAll = cookieWindow.document.getElementById('removeAllCookies');
  check(!removeAll.disabled, 'Remove All disabled with only WebKit cookies');
  removeAll.doCommand();
  cookieWindow.close();
  await waitFor(async () => {
    for (const api of apis) if (await api.executeScript('return document.cookie;')) return false;
    return true;
  }, 'remove all did not clear live stores');
  await seed();
  let sanitizer = new Sanitizer();
  sanitizer.range = [Date.now() * 1000 - 3600000000, Date.now() * 1000];
  sanitizer.ignoreTimespan = false;
  await sanitizer.sanitize(['cookies']);
  await verifyEmpty();
  // Quit with persistent cookies and keep-until-close enabled; the next phase
  // proves the async shutdown blocker waited for the native deletion.
  Services.prefs.setIntPref('network.cookie.lifetimePolicy', 2);
  Services.prefs.setBoolPref('privacy.sanitize.sanitizeOnShutdown', false);
  await seed();
  dump('CONTENT-TEST PASS live cookie manager, ranged sanitizer and new-tab menu\n');
}
