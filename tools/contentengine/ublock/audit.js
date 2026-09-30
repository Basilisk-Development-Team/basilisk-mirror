/* Test instrumentation only: never shipped or loaded by production chrome.
 * Uses the extension's existing settings APIs; does not change its source. */
Components.utils.import("resource://gre/modules/Services.jsm");
const Ci = Components.interfaces;
async function waitFor(test, label) {
  const start=Date.now();
  while(Date.now()-start<=60000) {
    if(await test())return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Timeout: '+label);
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
    if (message instanceof Ci.nsIScriptError && /contentengine|Content extension/.test(message.sourceName))
      dump('UBLOCK-AUDIT BRIDGE ERROR '+message.message+'\n');
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
  await waitFor(() => !bg.µBlock.loadingFilterLists, "initial list load");
  bg.µBlock.saveSelectedFilterLists(['user-filters']);
  await new Promise(resolve => bg.µBlock.loadFilterLists(resolve));
  if (!Services.prefs.getBoolPref('content.audit.restarted',false)) {
    let count = bg.µBlock.staticNetFilteringEngine.acceptedCount;
    bg.µBlock.appendUserFilters("*/audit-blocked*\n127.0.0.1##.audit-ad\n##.basilisk-audit-generic\n##.basilisk-audit-exception\n127.0.0.1#@#.basilisk-audit-exception\n");
    await waitFor(() => bg.µBlock.staticNetFilteringEngine.acceptedCount > count, "user filter compilation");
    dump("UBLOCK-AUDIT filters configured through extension API\n");
  } else {
    await waitFor(()=>!bg.µBlock.loadingFilterLists && bg.µBlock.staticNetFilteringEngine.acceptedCount>0,'persisted list load');
    dump('UBLOCK-AUDIT reusing saved extension settings and lists after restart\n');
  }
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", "about:blank");
  await waitFor(() => win.gBrowser && win.gBrowserInit.delayedStartupFinished, "browser startup");
  let g = win.gBrowser;
  // Place the extension's own widget through the normal customization API.
  // Its legacy toolbar path appends directly to the DOM on first install,
  // which does not save a placement in Basilisk's customization state.
  if (!Services.prefs.getBoolPref('content.audit.restarted',false)) {
    await waitFor(() => win.document.getElementById(bg.vAPI.toolbarButton.id) ||
      win.gNavToolbox.palette.querySelector('#'+bg.vAPI.toolbarButton.id), 'toolbar widget');
    win.CustomizableUI.addWidgetToArea(bg.vAPI.toolbarButton.id,win.CustomizableUI.AREA_NAVBAR);
  }
  await waitFor(() => win.document.getElementById(bg.vAPI.toolbarButton.id), "toolbar creation");
  dump("UBLOCK-AUDIT toolbar " + JSON.stringify({present:true, id:bg.vAPI.toolbarButton.id, path:bg.vAPI.toolbarButton.codePath}) + "\n");
  await new Promise(resolve => bg.vAPI.storage.set({contentExtensionAudit:'stored'}, resolve));
  let stored = await new Promise(resolve => bg.vAPI.storage.get('contentExtensionAudit', resolve));
  dump('UBLOCK-AUDIT storage '+JSON.stringify(stored)+'\n');
  let policy = [], locations = [];
  let mm = Components.classes['@mozilla.org/globalmessagemanager;1'].getService(Ci.nsIMessageListenerManager);
  mm.addMessageListener('ublock0:shouldLoad', message => policy.push(message.data.url));
  mm.addMessageListener('ublock0:locationChanged', message => locations.push(message.data.url));
  bg.µBlock.logger.readAll('content-audit');
  let acceptanceFailures = [];
  const probes = ['.js','-third-script','-image','-style','-frame','-fetch','-xhr','-socket','-redirect'];
  for (let engine of ['gecko', 'webkit']) {
    let tab = engine == 'gecko' ? g.addTab(base+'/page?engine=gecko') : win.ContentEngines.open(base+'/page?engine=webkit');
    g.selectedTab = tab;
    await waitFor(() => tab.linkedBrowser.contentTitle == 'Audit page' && !tab.hasAttribute('busy'), engine+' load');
    await new Promise(resolve => setTimeout(resolve, 1500));
    let result = await tab.linkedBrowser.contentAPI.executeScript("return {allowed:document.body.getAttribute('data-allowed'),external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display,dynamic:getComputedStyle(document.querySelector('.dynamic')).display,generic:getComputedStyle(document.querySelector('.basilisk-audit-generic')).display,excepted:getComputedStyle(document.querySelector('.basilisk-audit-exception')).display,load:document.body.dataset.load,frames:document.querySelectorAll('iframe').length};");
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
      Services.focus.setFocus(button,Ci.nsIFocusManager.FLAG_RAISE);
      await new Promise(resolve=>setTimeout(resolve,100));
      panel.openPopup(button, 'after_start', 0, 0, false, false);
      await new Promise(resolve => setTimeout(resolve, 1000));
      let frame = panel.querySelector('iframe');
      dump('UBLOCK-AUDIT POPUP READY '+JSON.stringify({state:panel.state,
        uri:frame&&frame.contentDocument.location.href,ready:frame&&frame.contentDocument.readyState,
        api:!!(frame&&frame.contentWindow.wrappedJSObject.vAPI),
        pending:frame&&frame.contentWindow.wrappedJSObject.vAPI&&frame.contentWindow.wrappedJSObject.vAPI.messaging&&frame.contentWindow.wrappedJSObject.vAPI.messaging.pending.size})+'\n');
      if(frame)await waitFor(()=> {
        const popup=frame.contentWindow.wrappedJSObject;
        return frame.contentDocument.readyState==='complete'&&popup.vAPI&&
          popup.vAPI.messaging&&popup.vAPI.messaging.pending.size===0;
      },engine+' popup responses');
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
      if(engine=='webkit' && requests)acceptanceFailures.push('WebKit request reached server: '+path);
    }
    dump('UBLOCK-AUDIT PRECHECK '+JSON.stringify(result)+'\n');
    if(result.allowed!='loaded')throw Error(engine+' allowed script missing');
    // EasyList explicitly exempts loopback from generic cosmetics. The
    // controlled user-list run has no such exception and must hide the target.
    result.genericHideException=bg.µBlock.staticNetFilteringEngine.matchStringGenericHide(null,base+'/page')===2;
    if(result.generic!==(result.genericHideException?'block':'none')||result.excepted!=='block')
      throw Error(engine+' generic cosmetic or domain exception failed: '+JSON.stringify(result));
    for(let path of probes.filter(p=>p!='-redirect')) {
      if(!result.server['/audit-allowed'+path+'?engine='+engine])throw Error(engine+' allowed control missing '+path);
    }
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', false);
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.disabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
    bg.µBlock.toggleNetFilteringSwitch(base+'/page?engine='+engine, 'site', true);
    tab.linkedBrowser.reload();await new Promise(resolve=>setTimeout(resolve,1500));
    result.reenabled = await tab.linkedBrowser.contentAPI.executeScript("return {external:document.body.getAttribute('data-external'),display:getComputedStyle(document.querySelector('.audit-ad')).display};");
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
    const site=Services.prefs.getCharPref('content.audit.site');
    if (site) {
      tab.linkedBrowser.loadURI(site);
      await waitFor(()=>tab.linkedBrowser.currentURI.spec.indexOf(site)===0&&!tab.hasAttribute('busy'),engine+' diagnostic navigation');
      await new Promise(resolve=>setTimeout(resolve,10000));
      const page=await tab.linkedBrowser.contentAPI.executeScript('return {uri:location.href,title:document.title,text:document.body.innerText};');
      dump('UBLOCK-AUDIT SITE '+JSON.stringify({engine,page})+'\n');
    }
  }
  const cacheStart=Date.now(),cached=win.ContentEngines.open(base+'/page?engine=webkit-cache');
  await waitFor(()=>cached.linkedBrowser.contentTitle==='Audit page'&&!cached.hasAttribute('busy'),'additional WebKit view');
  const cachedCounts=await new Promise(resolve=>{let x=new XMLHttpRequest();x.open('GET',base+'/counts');x.onload=()=>resolve(JSON.parse(x.responseText));x.send();});
  for(const path of probes)
    if(cachedCounts['/audit-blocked'+path+'?engine=webkit-cache'])throw Error('Additional view leaked request '+path);
  if(!cachedCounts['/audit-allowed.js?engine=webkit-cache'])throw Error('Additional view blocked allowed script');
  dump('UBLOCK-AUDIT ADDITIONAL VIEW '+JSON.stringify({ms:Date.now()-cacheStart,blockedRequests:0})+'\n');
  g.removeTab(cached);
  const cycles=Services.prefs.getIntPref('content.audit.switches');
  if(cycles) {
    const started=Date.now();let stress=g.addTab('about:blank');g.selectedTab=stress;
    for(let cycle=0;cycle<cycles;cycle++) {
      const uri=base+'/page?engine=cycle-'+cycle;
      stress.linkedBrowser.loadURI(uri);
      await waitFor(()=>stress.linkedBrowser.currentURI.spec===uri&&stress.linkedBrowser.contentTitle==='Audit page'&&!stress.hasAttribute('busy'),'Gecko stress load '+cycle);
      for(const engine of ['webkit','gecko']) {
        stress=win.ContentEngines.switchEngine(stress,engine);
        await waitFor(()=>stress.linkedBrowser.currentURI.spec===uri&&stress.linkedBrowser.contentTitle==='Audit page'&&!stress.hasAttribute('busy'),engine+' stress load '+cycle);
        if(stress.linkedBrowser.contentEngine!==engine)throw Error('Stress wrong engine');
        const data=await stress.linkedBrowser.contentAPI.executeScript("return {allowed:document.body.dataset.allowed,blocked:document.body.dataset.external,display:getComputedStyle(document.querySelector('.audit-ad')).display};");
        if(data.allowed!=='loaded'||data.blocked||data.display!=='none')throw Error(engine+' stress filtering state '+JSON.stringify(data));
        const counters=await new Promise(resolve=>{let x=new XMLHttpRequest();x.open('GET',base+'/counts');x.onload=()=>resolve(JSON.parse(x.responseText));x.send();});
        for(const path of probes)
          if(counters['/audit-blocked'+path+'?engine=cycle-'+cycle])throw Error(engine+' stress request reached server '+cycle+' '+path);
      }
      if((cycle+1)%10===0)dump('UBLOCK-AUDIT STRESS '+JSON.stringify({cycles:cycle+1,ms:Date.now()-started})+'\n');
    }
    g.removeTab(stress);
    dump('UBLOCK-AUDIT STRESS PASS '+cycles+' mixed-engine cycles; blocked counters zero, allowed controls and cosmetics present\n');
  }
  let dashboard = g.addTab('chrome://ublock0/content/dashboard.html'); g.selectedTab = dashboard;
  await waitFor(() => dashboard.linkedBrowser.contentDocument.readyState == 'complete' &&
    dashboard.linkedBrowser.currentURI.spec.includes('dashboard.html'), 'dashboard');
  dump('UBLOCK-AUDIT dashboard '+dashboard.linkedBrowser.contentDocument.title+'\n');
  // Wait for the real settings pane and its asynchronous background replies
  // before closing it; unloading a pending legacy callback supplies null.
  await waitFor(()=> {
    const outer=dashboard.linkedBrowser.contentWindow.wrappedJSObject;
    const pane=outer.document.getElementById('iframe');
    const inner=pane&&pane.contentWindow.wrappedJSObject;
    return inner&&inner.location.href.includes('settings.html')&&
      inner.document.readyState==='complete'&&
      [outer,inner].every(scope=>scope.vAPI&&scope.vAPI.messaging&&scope.vAPI.messaging.pending.size===0);
  },'dashboard settings and background replies');
  await dashboard.linkedBrowser.contentDocument.fonts.ready;
  await dashboard.linkedBrowser.contentDocument.getElementById('iframe').contentDocument.fonts.ready;
  g.removeTab(dashboard);
  const {AddonManager}=Components.utils.import('resource://gre/modules/AddonManager.jsm',{});
  const addon=await new Promise(resolve=>AddonManager.getAddonByID('uBlock0@raymondhill.net',resolve));
  const lifecycle=win.ContentEngines.open(base+'/page?engine=lifecycle-before');
  g.selectedTab=lifecycle;
  await waitFor(()=>lifecycle.linkedBrowser.contentTitle==='Audit page'&&!lifecycle.hasAttribute('busy'),'extension lifecycle initial page');
  addon.userDisabled=true;
  await waitFor(()=>!addon.isActive,'extension disabled');
  lifecycle.linkedBrowser.loadURI(base+'/page?engine=lifecycle-disabled');
  await waitFor(()=>lifecycle.linkedBrowser.contentTitle==='Audit page'&&!lifecycle.hasAttribute('busy')&&
    lifecycle.linkedBrowser.contentAPI.executeScript("return document.body.dataset.external==='loaded' && getComputedStyle(document.querySelector('.audit-ad')).display!=='none'"),'disabled extension releases filtering');
  addon.userDisabled=false;
  await waitFor(()=> {
    const current=provider.bootstrapScopes['uBlock0@raymondhill.net'];
    if(!current)return false;
    let background=Components.utils.evalInSandbox('bgProcess && bgProcess.contentWindow',current);
    if(background)background=background.wrappedJSObject;
    return background && background.µBlock && !background.µBlock.loadingFilterLists &&
      background.µBlock.staticNetFilteringEngine.acceptedCount>0;
  },'extension re-enabled');
  lifecycle.linkedBrowser.loadURI(base+'/page?engine=lifecycle-enabled');
  await waitFor(()=>lifecycle.linkedBrowser.currentURI.spec.includes('lifecycle-enabled')&&
    lifecycle.linkedBrowser.contentTitle==='Audit page'&&!lifecycle.hasAttribute('busy'),'re-enabled extension page');
  const lifecycleResult=await lifecycle.linkedBrowser.contentAPI.executeScript("return {allowed:document.body.dataset.allowed,blocked:document.body.dataset.external,display:getComputedStyle(document.querySelector('.audit-ad')).display}");
  if(lifecycleResult.allowed!=='loaded'||lifecycleResult.blocked||lifecycleResult.display!=='none')
    throw Error('Extension disable/re-enable regression '+JSON.stringify(lifecycleResult));
  dump('UBLOCK-AUDIT EXTENSION LIFECYCLE PASS disable/re-enable with an existing WebKit tab\n');
  g.removeTab(lifecycle);
  dump('UBLOCK-AUDIT extension errors '+JSON.stringify(errors)+'\n');
  if(errors.length)throw Error('Extension reported script errors: '+errors.join('; '));
  dump('UBLOCK-AUDIT ACCEPTANCE '+(acceptanceFailures.length?'FAIL ':'PASS ')+JSON.stringify(acceptanceFailures)+'\n');
  if(Services.prefs.getBoolPref('content.audit.requireWebKit') && acceptanceFailures.length)throw Error(acceptanceFailures.join('; '));
}
