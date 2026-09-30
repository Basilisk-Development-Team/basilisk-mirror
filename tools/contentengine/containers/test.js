/* Container identity and native storage isolation regression fixture. */
Components.utils.import('resource://gre/modules/Services.jsm');
function check(value,label){if(!value)throw Error(label);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitFor(test,label){for(let i=0;i<300;i++){if(await test())return;await delay(100);}throw Error(label);}
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
async function run(){
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 const win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'startup');
 const g=win.gBrowser;
 async function ready(tab){await waitFor(()=>tab.linkedBrowser.contentTitle==='Content fixture'&&!tab.hasAttribute('busy'),'load');return tab.linkedBrowser.contentAPI;}
 const phase=Services.prefs.getCharPref('content.test.phase');
 if(phase==='read'){
  for(const id of [0,1,2]){
   const tab=win.ContentEngines.open(base+'/containers',true,true,'webkit',id),api=await ready(tab);
   check(await api.executeScript('return document.cookie;')==='container='+id,'cookie partition lost after restart');
   check(await api.executeScript("return localStorage.getItem('container');")===String(id),'localStorage partition lost after restart');
  }
  dump('CONTENT-TEST PASS isolated container storage after browser restart\n');
  return;
 }
 for(const id of [0,1,2]){
  const gecko=g.addTab(base+'/containers',{userContextId:id});await ready(gecko);
  const tab=win.ContentEngines.switchEngine(gecko,'webkit');const api=await ready(tab);
  check((Number(tab.getAttribute('usercontextid'))||0)===id,'identity lost switching');
  check(tab.linkedBrowser.contentPrincipal.originAttributes.userContextId===id,'principal identity');
  check(await api.executeScript('return document.cookie;')==='','cookie leaked into container');
  check(await api.executeScript("return localStorage.getItem('container');")===null,'localStorage leaked');
  check((Number(JSON.parse(win.SessionStore.getTabState(tab)).attributes.usercontextid)||0)===id,'session restore lost container identity');
  await api.executeScript("document.cookie='container="+id+";path=/;max-age=86400';localStorage.setItem('container','"+id+"');");
 }
 for(const id of [0,1,2]){
  const tab=win.ContentEngines.open(base+'/containers',true,true,'webkit',id),api=await ready(tab);
  check(await api.executeScript('return document.cookie;')==='container='+id,'container cookie not shared');
  check(await api.executeScript("return localStorage.getItem('container');")===String(id),'container localStorage not shared');
  const gecko=win.ContentEngines.switchEngine(tab,'gecko');await ready(gecko);
  check((Number(gecko.getAttribute('usercontextid'))||0)===id,'identity lost returning to Gecko');
 }
 dump('CONTENT-TEST PASS container identity both engine directions, cookies and localStorage isolated and shared within container\n');
}
