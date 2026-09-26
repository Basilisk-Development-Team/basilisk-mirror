/* MPL 2.0: http://mozilla.org/MPL/2.0/ */
Components.utils.import('resource://gre/modules/Services.jsm');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(value,label){if(!value)throw Error(label);}
async function waitFor(test,label){for(let n=0;n<300;n++){if(await test())return;await delay(100);}throw Error(label);}
async function rejects(p,label){let rejected=false;try{await p;}catch(e){rejected=true;}check(rejected,label);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
function finish(e){dump('CONTENT-TEST '+(e?'FAIL '+e+'\n'+e.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
async function run(){
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 let win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.legacyFixture&&win.legacyOtherFixture,'installed extensions');
 let tab=win.ContentEngines.open(base+'/frames');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'content');
 let browser=tab.linkedBrowser, api=browser.contentAPI;
 await rejects(win.LegacyXULContentRuntime.open(browser),'non-extension callsite accepted');
 let a=await win.legacyFixture.open(browser), b=await win.legacyOtherFixture.open(browser);
 let one=await a.createTarget(), two=await b.createTarget();
 await a.setData(one,{value:'owned',nested:{x:1}});
 let messages=[];a.addMessageListener('ready',m=>messages.push(m));
 let first=a.loadSubScript(win.legacyFixture.uri('first.js'),one);
 let second=a.loadSubScript(win.legacyFixture.uri('second.js'),one);
 await Promise.all([first,second]);
 check(await a.executeScript(one,"return fixtureOrder.join(',')")=='first,second','global script ordering');
 check(await b.executeScript(two,'return typeof fixtureOrder')=='undefined','world globals leaked');
 await rejects(b.executeScript(one,'return 1'),'foreign target accepted');
 await rejects(a.loadSubScript(win.legacyOtherFixture.uri('first.js'),one),'foreign extension source accepted');
 check(await a.executeScript(one,'return Object.isFrozen(legacyContent.getData("nested"))'),'snapshot mutable');
 await waitFor(()=>messages.length==1,'outgoing message');
 check(messages[0].data.data=='owned'&&messages[0].target===one,'message identity/data');
 let echo=[];a.addMessageListener('echo',m=>echo.push(m));await a.sendAsyncMessage(one,'echo',{ok:true});
 await waitFor(()=>echo.length==1,'incoming message');check(echo[0].data.data.ok,'message payload');
 await rejects(a.loadSubScript(win.legacyFixture.uri('privileged.js'),one),'privileged source accepted');
 await rejects(a.executeScript(one,"throw Error('labelled failure')"),'script failure ignored');
 check(await a.executeScript(one,'return fixtureOrder.length')==2,'queue stopped after error');
 let frames=await api.getFrames(), child=await a.createTarget(frames.find(f=>!f.isTopFrame).frameId);
 await api.executeScript('document.querySelectorAll("iframe").forEach(f=>f.remove());');
 await rejects(a.executeScript(child,'return 1'),'destroyed frame target accepted');
 browser.reload();await waitFor(()=>browser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'reload');
 await rejects(a.executeScript(one,'return 1'),'navigation target accepted');
 let fresh=await a.createTarget();check(await a.executeScript(fresh,'return typeof fixtureOrder')=='undefined','old document world survived');

 let phaseMessages=[];a.addMessageListener('phase',m=>phaseMessages.push(m));
 await a.setDefaultData({value:'registered'});
 let registrations=await Promise.all([
  a.loadFrameScript(win.legacyFixture.uri('start.js'),{runAt:'document-start',allFrames:true}),
  a.loadFrameScript(win.legacyFixture.uri('end.js'),{runAt:'document-end',allFrames:true})]);
 await rejects(a.loadFrameScript(win.legacyFixture.uri('end.js'),{runAt:'document-idle'}),'unsupported idle promised');
 let css=await a.insertCSS('#target {color:rgb(4, 5, 6) !important}',{allFrames:true});
 let progress=[];a.addProgressListener(state=>progress.push(state));
 browser.loadURI(base+'/frames?registered');
 await waitFor(()=>browser.currentURI.spec.includes('?registered')&&!tab.hasAttribute('busy'),'registered reload');
 await waitFor(()=>phaseMessages.length==3,'registered all-frame messages');
 for(let message of phaseMessages){
  check(message.data.order=='start,end'&&message.data.data=='registered','phase order/data');
  let result=await a.executeScript(message.target,"return {phase:phaseOrder.join(','),before:document.body.dataset.pageStart,color:getComputedStyle(document.getElementById('target')).color,privileged:typeof Components};");
  check(result.phase=='start,end'&&result.before=='yes'&&result.color=='rgb(4, 5, 6)'&&result.privileged=='undefined','registered globals/phase/CSS');
 }
 check(progress.some(state=>state.loading)&&progress.some(state=>!state.loading),'progress bindings');
 await api.executeScript("let f=document.createElement('iframe');f.src='/dynamic';document.body.appendChild(f);");
 await waitFor(()=>phaseMessages.length==4,'dynamic frame registration');
 let responses=[];a.addMessageListener('frame-echo',m=>responses.push(m));
 for(let message of phaseMessages)await a.sendAsyncMessage(message.target,'frame-echo',message.frame.frameId);
 await waitFor(()=>responses.length==4,'targeted frame replies');
 for(let response of responses)check(response.data===response.frame.frameId,'cross-frame routing');
 let pending=a.executeScript(phaseMessages[3].target,'await new Promise(()=>{});');
 let cancelled=rejects(pending,'pending frame execution survived destruction');
 await api.executeScript("document.querySelector('iframe[src=\"/dynamic\"]').remove();");await cancelled;
 dump('LEGACY PASS registration phases, all-frame globals/data/CSS, dynamic frames, scoped messages and pending cancellation\n');
 let beforeCrash=phaseMessages[0].target;
 dump('CONTENT-TEST KILL WebProcesses\n');
 await waitFor(()=>win.ContentEngines.get(browser).native.lastError.includes('terminated'),'process termination');
 await rejects(a.executeScript(beforeCrash,'return 1'),'crash target survived');
 phaseMessages.length=0;browser.reload();
 await waitFor(()=>phaseMessages.length==3,'registrations after process recovery');
 check(await a.executeScript(phaseMessages[0].target,"return phaseOrder.join(',')")=='start,end','recovered registration world differs from execution world');
 await a.removeCSS(css);
 for(let token of registrations)await a.removeDelayedFrameScript(token);
 browser.loadURI(base+'/child?removed');
 await waitFor(()=>browser.currentURI.spec.includes('?removed')&&!tab.hasAttribute('busy'),'removed registrations');
 fresh=await a.createTarget();
 check(await a.executeScript(fresh,'return typeof phaseOrder')=='undefined','registration leaked');
 check(await a.executeScript(fresh,"return getComputedStyle(document.getElementById('target')).color")!='rgb(4, 5, 6)','CSS leaked');
 let cycleStart=Date.now();
 for(let cycle=0;cycle<100;cycle++){
  let context=await win.legacyFixture.open(browser),target=await context.createTarget();
  check(await context.executeScript(target,'return 7')==7,'world recreation');
  await context.close();await rejects(context.executeScript(target,'return 1'),'closed context usable');
 }
 dump('LEGACY PASS process recovery, removal, 100 independent world create/release cycles in '+(Date.now()-cycleStart)+' ms\n');
 tab=win.ContentEngines.switchEngine(tab,'gecko');
 await rejects(a.executeScript(fresh,'return 1'),'engine switch target accepted');
 await a.close();await b.close();
 let closingTab=win.ContentEngines.open(base+'/child?closing');
 await waitFor(()=>closingTab.linkedBrowser.contentTitle=='Content fixture'&&!closingTab.hasAttribute('busy'),'closing tab');
 let closing=await win.legacyFixture.open(closingTab.linkedBrowser),closingTarget=await closing.createTarget();
 let pendingClose=rejects(closing.executeScript(closingTarget,'await new Promise(()=>{});'),'tab close retained pending target');
 await delay(100);win.gBrowser.removeTab(closingTab,{animate:false});await pendingClose;
 await rejects(closing.createTarget(),'closed tab context accepted target');await closing.close();
 dump('LEGACY PASS separate worlds, ordered source globals, snapshots, messages, source eligibility, stale frames/navigation/switch\n');
}
