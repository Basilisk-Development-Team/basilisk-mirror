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
  dump('UBLOCK-AUDIT platform '+Services.appinfo.platformVersion+'\n');
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
  const compiledProbe = Services.prefs.getBoolPref("content.audit.compiledProbe");
  let adapter;
  if (compiledProbe) {
    await waitFor(() => !bg.µBlock.loadingFilterLists, "initial list load");
    bg.µBlock.saveSelectedFilterLists(['user-filters']);
    await new Promise(resolve => bg.µBlock.loadFilterLists(resolve));
    adapter = {};
    Services.scriptloader.loadSubScript("chrome://browser/content/contentengine/ublock-state-probe.js", adapter, "UTF-8");
  }
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
  let acceptanceFailures = [];
  const probes = ['.js','-third-script','-image','-style','-frame','-fetch','-xhr','-socket','-redirect'];
  for (let engine of ['gecko', 'webkit']) {
    let tab = engine == 'gecko' ? g.addTab(base+'/page?engine=gecko') : win.ContentEngines.open(compiledProbe ? 'about:blank' : base+'/page?engine=webkit');
    let probeCSS = null;
    async function installProbeState() {
      if (!compiledProbe || engine != 'webkit') return;
      const url = base+'/page?engine=webkit';
      const page = adapter.UBlockStateAdapter.pageState('1.16.6.1', bg, url);
      if (probeCSS) { await tab.linkedBrowser.contentAPI.removeCSS(probeCSS); probeCSS = null; }
      if (!page.enabled) {
        await tab.linkedBrowser.contentAPI.removeRequestRules('compiled-state-probe');
        return;
      }
      const snapshot = adapter.UBlockStateAdapter.snapshot('1.16.6.1', bg);
      const compiled = adapter.UBlockStateAdapter.compileStaticNetwork(snapshot);
      if (compiled.unsupported.length) throw Error('Probe contains unsupported predicates: '+JSON.stringify(compiled.unsupported));
      if (!compiled.rules.length) throw Error('Probe exported no active rules');
      await tab.linkedBrowser.contentAPI.setRequestRules('compiled-state-probe', compiled.rules);
      if (page.css) probeCSS = await tab.linkedBrowser.contentAPI.insertCSS(page.css);
      dump('UBLOCK-AUDIT COMPILED PROBE installed '+compiled.rules.length+' rules from live extension state\n');
    }
    if (compiledProbe && engine == 'webkit') {
      await installProbeState();
      tab.linkedBrowser.loadURI(base+'/page?engine=webkit');
    }
    g.selectedTab = tab;
    await waitFor(() => tab.linkedBrowser.contentTitle == 'Audit page' && !tab.hasAttribute('busy'), engine+' load');
    await new Promise(resolve => setTimeout(resolve, 1500));
    let result = await tab.linkedBrowser.contentAPI.executeScript("return {allowed:document.body.getAttribute('data-allowed'),external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display,dynamic:getComputedStyle(document.querySelector('.dynamic')).display,load:document.body.dataset.load,frames:document.querySelectorAll('iframe').length};");
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
    result.pickerFrames = (await tab.linkedBrowser.contentAPI.executeScript("return document.querySelectorAll('iframe').length;")) - result.frames;
    bg.vAPI.tabs.reload(info.id);
    await new Promise(resolve=>setTimeout(resolve,1500));
    result.extensionReloadLoad = await tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.load;");
    result.server = await new Promise(resolve=> {let xhr=new XMLHttpRequest();xhr.open('GET',base+'/counts');xhr.onload=()=>resolve(JSON.parse(xhr.responseText));xhr.send();});
    result.blockedRequests = {};
    for(let path of probes) {
      let requests=result.server['/audit-blocked'+path+'?engine='+engine]||0;
      result.blockedRequests[path] = requests;
      if(engine=='gecko' && requests)throw Error('Gecko network block reached server '+path);
      if(engine=='webkit' && requests && compiledProbe)throw Error('Compiled uBlock rule reached server '+path);
      if(engine=='webkit' && requests)acceptanceFailures.push('WebKit request reached server: '+path);
    }
    if(compiledProbe && engine=='webkit')dump('UBLOCK-AUDIT COMPILED PROBE PASS nine blocked resource counters zero\n');
    if(result.allowed!='loaded')throw Error(engine+' allowed script missing');
    for(let path of probes.filter(p=>p!='-redirect')) {
      if(!result.server['/audit-allowed'+path+'?engine='+engine])throw Error(engine+' allowed control missing '+path);
    }
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', false);
    await installProbeState();
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.disabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', true);
    await installProbeState();
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.reenabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
    if (compiledProbe && engine == 'webkit') {
      if (result.display != 'none' || result.dynamic != 'none' || result.disabled.external != 'loaded' ||
          result.disabled.display != 'block' || result.reenabled.external || result.reenabled.display != 'none')
        throw Error('Compiled probe cosmetic/site-state translation failed');
      const finalCounts = await new Promise(resolve => {let x=new XMLHttpRequest();x.open('GET',base+'/counts');x.onload=()=>resolve(JSON.parse(x.responseText));x.send();});
      for (const path of probes)
        if (finalCounts['/audit-blocked'+path+'?engine=webkit'] !== 1)
          throw Error('Site toggle server-counter mismatch '+path);
      dump('UBLOCK-AUDIT COMPILED PROBE PASS declarative/dynamic CSS and site disable/reenable\n');
    }
    if(engine=='webkit') {
      if(result.display!='none'||result.dynamic!='none')acceptanceFailures.push('WebKit static/dynamic cosmetics absent');
      if(result.pageStoreURI!=result.tabURI)acceptanceFailures.push('WebKit page store missing');
      if(!result.logger)acceptanceFailures.push('WebKit request logger empty');
      if(result.pickerFrames!=1)acceptanceFailures.push('WebKit picker not injected');
      if(+result.extensionReloadLoad<=+result.load)acceptanceFailures.push('WebKit extension reload did not navigate');
      if(result.disabled.external!='loaded'||result.reenabled.external||result.reenabled.display!='none')acceptanceFailures.push('WebKit per-site toggle ineffective');
    }
    if(engine=='gecko' && (result.disabled.external!='loaded'||result.reenabled.external||result.reenabled.display!='none'))throw Error('Gecko per-site toggle regression');
    dump('UBLOCK-AUDIT RESULT '+JSON.stringify(result)+'\n');
    if (engine == 'gecko' && (result.external || result.display != 'none')) throw new Error('Gecko control filters failed');
  }
  let dashboard = g.addTab('chrome://ublock0/content/dashboard.html'); g.selectedTab = dashboard;
  await waitFor(() => dashboard.linkedBrowser.contentDocument.readyState == 'complete' &&
    dashboard.linkedBrowser.currentURI.spec.includes('dashboard.html'), 'dashboard');
  dump('UBLOCK-AUDIT dashboard '+dashboard.linkedBrowser.contentDocument.title+'\n');
  dump('UBLOCK-AUDIT extension errors '+JSON.stringify(errors)+'\n');
  dump('UBLOCK-AUDIT ACCEPTANCE '+(acceptanceFailures.length?'FAIL ':'PASS ')+JSON.stringify(acceptanceFailures)+'\n');
  if(Services.prefs.getBoolPref('content.audit.requireWebKit') && acceptanceFailures.length)throw Error(acceptanceFailures.join('; '));
}
