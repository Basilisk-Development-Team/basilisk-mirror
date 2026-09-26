/* Test instrumentation only: never shipped or loaded by production chrome.
 * Uses the extension's existing settings APIs; does not change its source. */
Components.utils.import("resource://gre/modules/Services.jsm");
const Ci = Components.interfaces;
function waitFor(test, label) {
  return new Promise((resolve, reject) => {
    let start = Date.now(), timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (Date.now()-start > 60000) throw new Error("Timeout: " + label);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 100);
  });
}
function finish(error) {
  dump("UBLOCK-AUDIT " + (error ? "FAIL " + error + "\n" + error.stack : "COMPLETE") + "\n");
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
window.addEventListener("load", () => run().then(() => finish(), finish));
async function run() {
  let errors = [];
  Services.console.registerListener({observe(message) {
    if (message instanceof Ci.nsIScriptError && /ublock/i.test(message.sourceName)) errors.push(message.message);
  }});
  const base = "http://127.0.0.1:" + Services.prefs.getIntPref("content.audit.port");
  const provider = Components.utils.import("resource://gre/modules/addons/XPIProvider.jsm", {}).XPIProvider;
  let scope, bg;
  await waitFor(() => {
    scope = provider.bootstrapScopes['uBlock0@raymondhill.net'];
    if (!scope) return false;
    bg = Components.utils.evalInSandbox("bgProcess && bgProcess.contentWindow", scope);
    if (bg) bg = bg.wrappedJSObject;
    return bg && bg.µBlock && bg.µBlock.availableFilterLists && bg.µBlock.availableFilterLists['user-filters'];
  }, "uBlock startup");
  let count = bg.µBlock.staticNetFilteringEngine.acceptedCount;
  bg.µBlock.appendUserFilters("*/audit-blocked*\n127.0.0.1##.audit-ad\n");
  await waitFor(() => bg.µBlock.staticNetFilteringEngine.acceptedCount > count, "user filter compilation");
  dump("UBLOCK-AUDIT filters configured through extension API\n");
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", "about:blank");
  await waitFor(() => win.gBrowser && win.gBrowserInit.delayedStartupFinished, "browser startup");
  let g = win.gBrowser;
  await waitFor(() => win.document.getElementById(bg.vAPI.toolbarButton.id), "toolbar creation");
  dump("UBLOCK-AUDIT toolbar " + JSON.stringify({present:true, id:bg.vAPI.toolbarButton.id, path:bg.vAPI.toolbarButton.codePath}) + "\n");
  await new Promise(resolve => bg.vAPI.storage.set({contentShimAudit:'stored'}, resolve));
  let stored = await new Promise(resolve => bg.vAPI.storage.get('contentShimAudit', resolve));
  dump('UBLOCK-AUDIT storage '+JSON.stringify(stored)+'\n');
  let policy = [], locations = [];
  let mm = Components.classes['@mozilla.org/globalmessagemanager;1'].getService(Ci.nsIMessageListenerManager);
  mm.addMessageListener('ublock0:shouldLoad', message => policy.push(message.data.url));
  mm.addMessageListener('ublock0:locationChanged', message => locations.push(message.data.url));
  bg.µBlock.logger.readAll('content-audit');
  for (let engine of ['gecko', 'webkit']) {
    let tab = engine == 'gecko' ? g.addTab(base+'/page?engine=gecko') : win.ContentEngines.open(base+'/page?engine=webkit');
    g.selectedTab = tab;
    await waitFor(() => tab.linkedBrowser.contentTitle == 'Audit page' && !tab.hasAttribute('busy'), engine+' load');
    await new Promise(resolve => setTimeout(resolve, 1500));
    let result = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display,dynamic:getComputedStyle(document.querySelector('.dynamic')).display,load:document.body.dataset.load,frames:document.querySelectorAll('iframe').length};");
    let info = await new Promise(resolve => bg.vAPI.tabs.get(null, resolve));
    let store = bg.µBlock.pageStoreFromTabId(info.id);
    result.engine = engine; result.tabURI = info.url; result.tabTitle = info.title;
    result.pageStoreURI = store && store.rawURL;
    result.policyMessages = policy.filter(uri => uri.includes('engine='+engine));
    result.locationMessages = locations.filter(uri => uri.includes('engine='+engine));
    let button = win.document.getElementById(bg.vAPI.toolbarButton.id);
    let panel = button.querySelector('panel');
    if (panel) {
      win.focus();
      panel.openPopup(button, 'after_start', 0, 0, false, false);
      await new Promise(resolve => setTimeout(resolve, 1000));
      let frame = panel.querySelector('iframe');
      result.popup = {state:panel.state, source:frame && frame.getAttribute('src'),
        uri:frame && frame.contentDocument.location.href, title:frame && frame.contentDocument.title};
      panel.hidePopup();
    }
    result.logger = bg.µBlock.logger.readAll('content-audit').filter(entry => JSON.stringify(entry).includes('audit-blocked') && JSON.stringify(entry).includes('engine='+engine)).length;
    bg.µBlock.elementPickerExec(info.id);
    await new Promise(resolve=>setTimeout(resolve,1000));
    result.pickerFrames = await tab.linkedBrowser.contentAPI.executeScript("return document.querySelectorAll('iframe').length;");
    bg.vAPI.tabs.reload(info.id);
    await new Promise(resolve=>setTimeout(resolve,1500));
    result.extensionReloadLoad = await tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.load;");
    result.server = await new Promise(resolve=> {let xhr=new XMLHttpRequest();xhr.open('GET',base+'/counts');xhr.onload=()=>resolve(JSON.parse(xhr.responseText));xhr.send();});
    for(let path of ['.js','-image','-fetch','-xhr']) {
      let requests=result.server['/audit-blocked'+path+'?engine='+engine]||0;
      if(engine=='gecko' && requests)throw Error('Gecko network block reached server '+path);
    }
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', false);
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.disabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', true);
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.reenabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
    dump('UBLOCK-AUDIT RESULT '+JSON.stringify(result)+'\n');
    if (engine == 'gecko' && (result.external || result.display != 'none')) throw new Error('Gecko control filters failed');
  }
  let dashboard = g.addTab('chrome://ublock0/content/dashboard.html'); g.selectedTab = dashboard;
  await waitFor(() => dashboard.linkedBrowser.contentDocument.readyState == 'complete' &&
    dashboard.linkedBrowser.currentURI.spec.includes('dashboard.html'), 'dashboard');
  dump('UBLOCK-AUDIT dashboard '+dashboard.linkedBrowser.contentDocument.title+'\n');
  dump('UBLOCK-AUDIT extension errors '+JSON.stringify(errors)+'\n');
}
