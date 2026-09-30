/* Exercise runtime enable/disable and the same UI in --disable-webkit builds. */
Components.utils.import('resource://gre/modules/Services.jsm');
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
  const built = '@basilisk-browser.org/content-view;1?engine=webkit' in Components.classes;
  if (built) check(Services.prefs.getDefaultBranch('').getBoolPref('webkit.enabled'), 'default preference not enabled');
  const base = 'http://127.0.0.1:' + Services.prefs.getIntPref('content.test.port');
  const win = window.openDialog('chrome://browser/content/browser.xul', '_blank', 'chrome,all,dialog=no', 'about:blank');
  await waitFor(() => win.gBrowserInit && win.gBrowserInit.delayedStartupFinished, 'startup');
  const dialogs = [];
  for (const path of ['sanitize.xul', 'preferences/sanitize.xul', 'preferences/cookies.xul']) {
    const dialog = window.openDialog('chrome://browser/content/' + path, '_blank', 'chrome,dialog=no');
    await waitFor(() => dialog.document.readyState == 'complete', 'dialog ' + path);
    dialogs.push(dialog);
  }
  const prefsTab = win.gBrowser.addTab('about:preferences#privacy');
  win.gBrowser.selectedTab = prefsTab;
  await waitFor(() => prefsTab.linkedBrowser.contentDocument &&
    prefsTab.linkedBrowser.contentDocument.getElementById('keepCookiesUntil'), 'preferences');
  const documents = [win.document, ...dialogs.map(dialog => dialog.document), prefsTab.linkedBrowser.contentDocument];
  function verifyUI(enabled) {
    const ids = ['context_reloadGecko', 'context_reloadWebKit', 'context_newWebKit', 'new-tab-button-newwebkit'];
    for (const id of ids) {
      const item = win.document.getElementById(id);
      check(built ? !!item && item.hidden == !enabled : !item, 'menu visibility ' + id);
    }
    for (const document of documents.slice(1)) {
      const note = document.getElementById('webkitCookieNote');
      check(built ? !!note && note.hidden == !enabled : !note, 'cookie note visibility ' + document.documentURI);
      if (enabled) {
        check(note.textContent.includes('WebKit API'), 'missing limitation explanation');
        if (dialogs.some(dialog => dialog.document === document)) {
          const box = note.getBoundingClientRect();
          check(box.height > 0 && box.bottom <= document.defaultView.innerHeight + 1,
            'cookie explanation clipped in ' + document.documentURI);
        }
      }
      else if (note) check(!note.textContent, 'disabled note contains text');
    }
  }
  // The runner starts this suite with the pref disabled, before any window loads.
  verifyUI(false);
  const profile = Services.dirsvc.get('ProfD', Components.interfaces.nsIFile);
  profile.append('webkit');
  check(!profile.exists(), 'disabled startup initialized native storage');
  Services.prefs.setCharPref('browser.contentEngine.default', 'webkit');
  Services.prefs.setCharPref('browser.contentEngine.siteRules', JSON.stringify({'127.0.0.1': 'webkit'}));
  async function ready(tab) {
    await waitFor(() => tab.linkedBrowser.contentTitle == 'Content fixture' && !tab.hasAttribute('busy'), 'page load');
  }
  const gecko = win.gBrowser.addTab(base + '/disabled');
  await ready(gecko);
  check(!built || !win.ContentEngines.get(gecko.linkedBrowser), 'disabled automatic routing');
  const {Sanitizer} = Components.utils.import('resource:///modules/Sanitizer.jsm', {});
  let sanitizer = new Sanitizer(); sanitizer.ignoreTimespan = true;
  await sanitizer.sanitize(['cookies']);
  check(!profile.exists(), 'disabled sanitization initialized native storage');
  Services.prefs.setBoolPref('webkit.enabled', true);
  verifyUI(built);
  if (!built) {
    check(!win.ContentEngines, 'content-engine scripts present in disabled build');
    check(!profile.exists(), 'disabled build created native storage');
    dump('CONTENT-TEST PASS no WebKit UI or engine in --disable-webkit build, even with pref true\n');
    return;
  }
  const live = win.ContentEngines.open(base + '/live');
  await ready(live);
  const view = win.ContentEngines.get(live.linkedBrowser);
  check(view, 'enabling did not permit native view');
  const state = win.SessionStore.getTabState(live);
  Services.prefs.setBoolPref('webkit.enabled', false);
  verifyUI(false);
  check(win.ContentEngines.get(live.linkedBrowser) === view && !view.destroyed, 'disabling destroyed existing tab');
  await live.linkedBrowser.contentAPI.executeScript("document.cookie='keep=yes;path=/;max-age=86400';");
  await sanitizer.sanitize(['cookies']);
  check(await live.linkedBrowser.contentAPI.executeScript('return document.cookie;') == 'keep=yes', 'disabled sanitizer cleared hidden engine cookies');
  live.linkedBrowser.loadURI(base + '/still-live');
  await ready(live);
  check(win.ContentEngines.get(live.linkedBrowser) === view, 'existing tab could not navigate');
  const fallback = win.ContentEngines.open(base + '/new-disabled');
  await ready(fallback);
  check(!win.ContentEngines.get(fallback.linkedBrowser), 'disabled open created native view');
  const native = Components.classes['@basilisk-browser.org/content-view;1?engine=webkit']
    .createInstance(Components.interfaces.nsIWebContentView);
  let blocked = false;
  try { native.attach(win, {onContentEvent() {}}, 0); } catch (error) { blocked = error.result == Components.results.NS_ERROR_NOT_AVAILABLE; }
  native.destroy();
  check(blocked, 'native attach bypassed disabled preference');
  const restored = win.gBrowser.addTab('about:blank');
  win.gBrowser.selectedTab = restored;
  win.SessionStore.setTabState(restored, state);
  await waitFor(() => Array.from(win.gBrowser.tabs).some(tab =>
    tab !== live && tab.linkedBrowser.currentURI.spec == base + '/live' &&
    tab.linkedBrowser.contentTitle == 'Content fixture' && !win.ContentEngines.get(tab.linkedBrowser)), 'disabled restore did not load URL in Gecko');
  win.gBrowser.removeTab(live, {animate: false});
  check(view.destroyed, 'closing disabled native tab did not destroy it');
  Services.prefs.setBoolPref('webkit.enabled', true);
  verifyUI(true);
  const again = win.ContentEngines.open(base + '/enabled-again');
  await ready(again);
  check(win.ContentEngines.get(again.linkedBrowser), 're-enabling failed');
  dump('CONTENT-TEST PASS startup disabled, live UI toggles, cookie notes, routing, restore, native guard and existing-tab lifetime\n');
  for (const dialog of dialogs) dialog.close();
}
