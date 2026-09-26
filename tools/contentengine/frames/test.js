/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
function check(value,label){if(!value)throw Error(label);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitFor(test,label){for(let i=0;i<300;i++){if(await test())return;await delay(100);}throw Error(label);}
async function rejects(value,label){let failed=false;try{await value;}catch(_){failed=true;}check(failed,label);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
async function run(){
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 let win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'startup');
 let tab=win.gBrowser.selectedTab, serial=0;
 for(const engine of ['gecko','webkit']){
  if(engine=='webkit')tab=win.ContentEngines.switchEngine(tab,engine);
  let api=tab.linkedBrowser.contentAPI, messages=[];
  api.addMessageListener((value,frame)=>messages.push({value,frame}));
  await api.registerScript('start',"document.documentElement.setAttribute('data-start','yes'); browserContent.sendMessage({phase:'start',state:document.readyState});",{runAt:'document-start',allFrames:true});
  await api.registerScript('end',"browserContent.addMessageListener(value=>browserContent.sendMessage({echo:value})); browserContent.sendMessage({phase:'end',state:document.readyState});",{runAt:'document-end',allFrames:true});
  await api.registerScript('idle',"browserContent.sendMessage({phase:'idle',state:document.readyState});",{runAt:'document-idle',allFrames:true});
  await api.insertCSS('#target {color:rgb(1, 2, 3) !important}', 'frame-style',{allFrames:true});
  async function load(path){tab.linkedBrowser.loadURI(base+path+'?'+(++serial));await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'load '+engine+path);}
  await load('/frames');
  let frames=[];await waitFor(async()=>{frames=await api.getFrames();return frames.length==3;},'three frames '+engine);
  check(frames.filter(f=>f.isTopFrame).length==1,'top identity');
  for(let frame of frames){
   let value=await api.executeScript("return {start:document.body.dataset.pageStart,color:getComputedStyle(document.getElementById('target')).color,components:typeof Components};",{frameId:frame.frameId});
   check(value.start=='yes','document-start after page script '+engine+JSON.stringify(value));
   check(value.color=='rgb(1, 2, 3)'&&value.components=='undefined','style or privilege leak '+engine);
   await api.sendMessage(frame.frameId,{frameId:frame.frameId});
  }
  await waitFor(()=>messages.filter(m=>m.value.echo).length==3,'targeted replies '+engine);
  for(let m of messages.filter(m=>m.value.echo))check(m.frame.frameId==m.value.echo,'cross-frame delivery');
  for(let phase of ['start','end','idle'])check(messages.filter(m=>m.value.phase==phase).length==3,'phase count '+engine+phase);
  let other=win.ContentEngines.open(base+'/child');
  await waitFor(()=>other.linkedBrowser.contentTitle=='Content fixture','other tab');
  await rejects(other.linkedBrowser.contentAPI.executeScript('return 1',{frameId:frames[0].frameId}),'cross-tab frame accepted');
  win.gBrowser.removeTab(other,{animate:false});win.gBrowser.selectedTab=tab;
  await api.executeScript("let f=document.createElement('iframe');f.src='/dynamic';document.body.appendChild(f);");
  await waitFor(async()=> (await api.getFrames()).length==4,'dynamic frame');
  let dynamic=(await api.getFrames()).find(f=>f.documentURI.includes('/dynamic'));
  check(await api.executeScript("return document.body.dataset.pageStart",{frameId:dynamic.frameId})=='yes','dynamic document-start');
  let pending=api.executeScript('await new Promise(()=>{});',{frameId:dynamic.frameId});
  // Observe rejection immediately; no unhandled-promise bookkeeping artifacts.
  let rejection=rejects(pending,'destroyed frame did not reject');
  await api.executeScript("document.querySelector('iframe[src=\"/dynamic\"]').remove();");
  await rejection;
  await rejects(api.executeScript('return 1',{frameId:dynamic.frameId}),'removed frame survived');
  let stale=frames[0].frameId;
  await load('/csp');
  check(await api.executeScript("document.getElementById('target').textContent='isolated';return document.getElementById('target').textContent;")=='isolated','CSP isolated execution');
  check(await api.executeScript("return getComputedStyle(document.getElementById('target')).color")=='rgb(1, 2, 3)','CSP user CSS');
  await rejects(api.executeScript('return 1',{frameId:stale}),'stale document token accepted');
  tab.linkedBrowser.goBack();await waitFor(()=>tab.linkedBrowser.currentURI.spec.includes('/frames')&&!tab.hasAttribute('busy'),'history restore');
  check((await api.getFrames()).length>=3,'BFCache/reload frame enumeration');
  let echoed=false;api.addMessageListener(value=>{if(value.back)echoed=true;});
  await api.executeScript('browserContent.sendMessage({back:true});');await waitFor(()=>echoed,'BFCache bridge');
  await api.removeCSS('frame-style');
  for(let token of ['start','end','idle'])await api.unregisterScript(token);
  await load('/child');
  check(await api.executeScript("return document.body.dataset.pageStart")=='null','registration survived removal');
  dump('CONTENT-TEST PASS '+engine+' timing, all-frame CSS, targeted messaging, CSP, dynamic frames, stale IDs, history and teardown\n');
 }
}
