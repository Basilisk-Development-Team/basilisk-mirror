/* Native input regression fixture. Clipboard values are synthetic test data. */
Components.utils.import('resource://gre/modules/Services.jsm');
function check(value,label){if(!value)throw Error(label);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitFor(test,label){for(let i=0;i<100;i++){if(await test())return;await delay(100);}throw Error(label);}
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
async function run(){
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 const win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'startup');
 const g=win.gBrowser,tab=win.ContentEngines.open(base+'/input',true,true,'webkit',1);
 await waitFor(()=>tab.linkedBrowser.contentTitle==='Input fixture'&&!tab.hasAttribute('busy'),'page');
 const api=tab.linkedBrowser.contentAPI,view=win.ContentEngines.get(tab.linkedBrowser);
 async function input(action){dump('CONTENT-TEST INPUT '+JSON.stringify(action)+'\n');await delay(300);}
 async function point(selector,button=1,shift=false){
  const p=await api.executeScript('const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.left+10,y:r.top+10};');
  const r=tab.linkedBrowser.getBoundingClientRect();
  await input({type:'click',x:win.mozInnerScreenX+r.left+p.x,y:win.mozInnerScreenY+r.top+p.y,button,shift});
 }
 async function focus(){g.selectedTab=tab;win.focus();view.focus();await point('#focus');}
 await focus();
 await input({type:'key',key:'ctrl+f'});
 await waitFor(()=>win.gFindBarInitialized&&!win.gFindBar.hidden,'browser find fallback');
 check(Number(await api.executeScript('return document.body.dataset.keys;'))===1,'page never received Ctrl+F');
 win.gFindBar.close();await focus();
 await api.executeScript("document.body.dataset.custom='yes';");
 await input({type:'key',key:'ctrl+f'});
 await waitFor(async()=>await api.executeScript('return document.body.dataset.found;')==='yes','page find handler');
 check(win.gFindBar.hidden,'browser find stole handled shortcut');
 await api.executeScript("document.body.dataset.custom='no';dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));");
 await delay(200);check(win.gFindBar.hidden,'synthetic event opened browser chrome');
 await api.executeScript("const f=document.createElement('iframe');f.id='child';f.src='/input-child';document.body.appendChild(f);");
 let child;
 await waitFor(async()=>{child=(await api.getFrames()).find(f=>!f.isTopFrame);return child;},'child frame');
 await waitFor(async()=>await api.executeScript("return !!document.getElementById('focus');",{frameId:child.frameId}),'child load');
 await focus();
 await api.executeScript("document.body.dataset.custom='yes';document.getElementById('focus').focus();",{frameId:child.frameId});
 await input({type:'key',key:'ctrl+f'});
 await waitFor(async()=>await api.executeScript('return document.body.dataset.found;',{frameId:child.frameId})==='yes','iframe find handler');
 check(win.gFindBar.hidden,'browser find stole iframe shortcut');
 await api.executeScript("document.body.dataset.custom='no';",{frameId:child.frameId});
 await input({type:'key',key:'ctrl+f'});
 await waitFor(()=>!win.gFindBar.hidden,'iframe browser find fallback');
 win.gFindBar.close();
 await api.executeScript("document.getElementById('child').remove();");
 dump('CONTENT-TEST PASS page-first Ctrl+F, fallback, synthetic event isolation\n');
 for(const item of [{id:'#link',shift:false},{id:'#blank',shift:false},{id:'#link',shift:true}]){
  await focus();const before=Array.from(g.tabs);
  await point(item.id,2,item.shift);
  await waitFor(()=>g.tabs.length===before.length+1,'middle click new tab');
  const created=Array.from(g.tabs).find(t=>!before.includes(t));
  check(Number(created.getAttribute('usercontextid'))===1,'new tab lost container');
  await waitFor(()=>created.linkedBrowser.currentURI.spec===base+(item.id==='#blank'?'/input-blank':'/input-target'),'middle click target');
  check(g.selectedTab===(item.shift?created:tab),'middle click foreground/background');
  check(tab.linkedBrowser.currentURI.spec===base+'/input','source navigated');
  await delay(200);check(g.tabs.length===before.length+1,'duplicate new tab');
  g.removeTab(created,{animate:false});
 }
 dump('CONTENT-TEST PASS middle click, target blank, shift-middle click\n');
 for(const text of ['dummy-password-01','dummy-pässword-02','']){
  await focus();await input({type:'clipboard',text});await delay(300);
  await api.executeScript("document.getElementById('password').value='';");
  await point('#password');await input({type:'key',key:'ctrl+v'});
  await waitFor(async()=>await api.executeScript("return document.getElementById('password').value;")===text,'paste mismatch');
 }
 dump('CONTENT-TEST PASS Ctrl+V password field, Unicode and empty clipboard\n');
}
