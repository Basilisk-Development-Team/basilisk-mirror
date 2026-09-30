/* Browser-owned pages must override alternate engine preferences and sessions. */
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
 const g=win.gBrowser,engines=win.ContentEngines;
 Services.prefs.setCharPref('browser.contentEngine.default','webkit');
 async function gecko(uri){
  await waitFor(()=>!engines.get()&&g.selectedBrowser.currentURI.spec===uri&&!g.selectedTab.hasAttribute('busy'),'Gecko '+uri);
  check(g.selectedBrowser.contentDocument,'missing Gecko document');
 }
 for(const uri of ['about:blank','about:config','about:preferences','about:support']){
  const tab=engines.open(uri,true,true,'webkit',1);await gecko(uri);
  check(g.selectedTab===tab,'new about page replaced unnecessarily');
  check(Number(tab.getAttribute('usercontextid'))===1,'new about page lost container');
  check(win.ContentEngineRouting.target(tab,uri)==='gecko','manual override captured about page');
  check(engines.switchEngine(tab,'webkit')===tab,'manual switch created WebKit about page');
  await gecko(uri);g.removeTab(tab,{animate:false});
 }
 dump('CONTENT-TEST PASS about pages override default/manual engine choices\n');
 async function web(){
  const tab=engines.open(base+'/about-fixture',true,true,'webkit',1);
  await waitFor(()=>tab.linkedBrowser.contentTitle==='Content fixture'&&!tab.hasAttribute('busy'),'WebKit page');
  return tab;
 }
 for(const path of ['browser','view','native','page']){
  const tab=await web();
  g.pinTab(tab);const pinnedPosition=tab._tPos;
  const view=engines.get(tab.linkedBrowser);
  // Mandatory routes must not be blocked by a prior redirect-loop guard.
  tab._contentRouteChain=Array.from({length:6},()=>({uri:'about:config',engine:'gecko',time:Date.now()}));
  if(path==='browser')tab.linkedBrowser.loadURI('about:config');
  else if(path==='view')view.loadURI('about:config');
  else if(path==='native')view.native.loadURI('about:blank');
  else await tab.linkedBrowser.contentAPI.executeScript("location.href='about:config';").catch(()=>{});
  await gecko(path==='native'?'about:blank':'about:config');
  check(g.selectedTab.pinned&&g.selectedTab._tPos===pinnedPosition,'position/pinning lost');
  check(Number(g.selectedTab.getAttribute('usercontextid'))===1,'navigation lost container');
  g.removeTab(g.selectedTab,{animate:false});
 }
 dump('CONTENT-TEST PASS chrome, direct view and native about navigation\n');
 let tab=await web();
 await tab.linkedBrowser.contentAPI.executeScript("const f=document.createElement('iframe');f.src='about:blank';document.body.appendChild(f);");
 await waitFor(async()=>(await tab.linkedBrowser.contentAPI.getFrames()).length===2,'about:blank iframe');
 check(engines.get(tab.linkedBrowser),'blank iframe switched top-level engine');
 const state=JSON.parse(win.SessionStore.getTabState(tab));
 state.extData['basilisk.contentURI']='about:support';
 g.removeTab(tab,{animate:false});
 const restored=g.addTab('about:blank',{userContextId:1});g.selectedTab=restored;
 win.SessionStore.setTabState(restored,JSON.stringify(state));
 await gecko('about:support');
 check(Number(g.selectedTab.getAttribute('usercontextid'))===1,'restore lost container');
 dump('CONTENT-TEST PASS saved WebKit about pages restore in Gecko; blank subframes stay local\n');
}
