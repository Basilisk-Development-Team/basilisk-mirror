/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
function check(value,label) {if(!value)throw Error(label);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitFor(test,label){for(let i=0;i<600;i++){if(test())return;await delay(100);}throw Error(label);}
window.addEventListener("load",()=>run().then(()=>finish(),finish));
function finish(error){dump("CONTENT-TEST "+(error?"FAIL "+error+"\n"+error.stack:"PASS all")+"\n");Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
async function run(){
 const base="http://127.0.0.1:"+Services.prefs.getIntPref("content.test.port");
 const source=await new Promise(resolve=>{let xhr=new XMLHttpRequest();xhr.open('GET','content.js');xhr.onload=()=>resolve(xhr.responseText);xhr.send();});
 let win=window.openDialog("chrome://browser/content/browser.xul","_blank","chrome,all,dialog=no",base);
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished&&win.gBrowser.selectedBrowser.contentTitle=="Content fixture","Gecko startup");
 const g=win.gBrowser;
 async function execute(browser,code){
  if(browser.contentAPI)return browser.contentAPI.executeScript(code);
  let sandbox=Components.utils.Sandbox(browser.contentWindow,{sandboxPrototype:browser.contentWindow,wantXrays:true,wantComponents:false});
  try{return JSON.parse(await Components.utils.evalInSandbox("(async function(){return JSON.stringify(await (async function(){"+code+"})());})()",sandbox,"latest"));}
  finally{Components.utils.nukeSandbox(sandbox);}
 }
 let gecko=await execute(g.selectedBrowser,source);dump("WEBRTC Gecko "+JSON.stringify(gecko)+"\n");
 check(gecko.message=='echo:hello'&&gecko.candidates>0,'Gecko local peer transport');
 if(!win.ContentEngines){
  // Let document-owned peer cleanup finish before destroying the test sandbox/window.
  g.selectedBrowser.loadURI('about:blank');
  await waitFor(()=>g.selectedBrowser.currentURI.spec=='about:blank'&&!g.selectedTab.hasAttribute('busy'),'Gecko cleanup navigation');
  await delay(1000);win.close();await delay(1000);return;
 }
 let tab=win.ContentEngines.open(base);
 await waitFor(()=>tab.linkedBrowser.contentTitle=="Content fixture"&&!tab.hasAttribute('busy'),"WPE startup");
 let api=tab.linkedBrowser.contentAPI, failures=[];
 for(let i=0;i<Services.prefs.getIntPref('content.test.cycles');i++){
  let result=await api.executeScript(source);dump("WEBRTC core "+i+" "+JSON.stringify(result)+"\n");
  if (!(result.exposed.peerConnection=="function"&&result.message=="echo:hello"&&result.candidates>0)) failures.push("core data-channel run "+i);
 }
 const audio=await new Promise(resolve=>{let xhr=new XMLHttpRequest();xhr.open('GET','audio.js');xhr.onload=()=>resolve(xhr.responseText);xhr.send();});
 dump("WEBRTC synthetic audio "+JSON.stringify(await api.executeScript(audio))+"\n");
 let advertised=!!(api.capabilities&Components.interfaces.nsIWebContentView.CAP_WEBRTC);
 dump("WEBRTC browser transport capability "+advertised+"\n");
 check(!failures.length || !advertised,"advertised transport despite failed local peer test");
 check(!(api.capabilities&Components.interfaces.nsIWebContentView.CAP_MEDIA_CAPTURE),"unsafe capture capability");
 let denied=[];tab.linkedBrowser.addEventListener('ContentPermissionDenied',e=>denied.push(e.detail));
 for(let constraints of [{audio:true},{video:true},{audio:true,video:true}]){
  let result=await api.executeScript("try {let stream=await navigator.mediaDevices.getUserMedia("+JSON.stringify(constraints)+");stream.getTracks().forEach(t=>t.stop());return {granted:true};} catch(e){return {name:e.name,message:e.message};}");
  dump("WEBRTC capture "+JSON.stringify(constraints)+" "+JSON.stringify(result)+"\n");check(!result.granted,"capture granted without trustworthy origin");
 }
 dump("WEBRTC permission events "+JSON.stringify(denied)+"\n");
 check(denied.some(e=>e.reason=='requesting-origin-unavailable'&&e.requestingOrigin===null),"missing generic safe denial event");
 await api.executeScript("let f=document.createElement('iframe');f.src='http://localhost:"+Services.prefs.getIntPref('content.test.port')+"/child';document.body.appendChild(f);");
 let frames=[];
 for(let i=0;i<100;i++){frames=await api.getFrames();if(frames.some(f=>f.documentURI.includes('localhost')))break;await delay(100);}
 let child=frames.find(f=>f.documentURI.includes('localhost'));check(child,'cross-origin frame missing');
 let cross=await api.executeScript("try {let s=await navigator.mediaDevices.getUserMedia({audio:true});s.getTracks().forEach(t=>t.stop());return 'granted';}catch(e){return e.name;}",{frameId:child.frameId});
 dump("WEBRTC cross-origin "+cross+"\n");check(cross!='granted','cross-origin permission granted');
 const hold="globalThis.rtc=new RTCPeerConnection({iceServers:[]});rtc.createDataChannel('lifecycle');await rtc.setLocalDescription(await rtc.createOffer());return rtc.localDescription.type;";
 await api.executeScript(hold);
 dump("CONTENT-TEST KILL WebProcesses\n");
 await waitFor(()=>win.ContentEngines.get(tab.linkedBrowser).native.lastError.includes('terminated'),'crash notification');
 tab.linkedBrowser.reload();
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'crash reload');
 if((await api.executeScript(source)).message!='echo:hello')failures.push('peer transport after crash recovery');
 let pending=api.executeScript("await navigator.mediaDevices.getUserMedia({audio:true});").then(()=>false,()=>true);
 tab=win.ContentEngines.switchEngine(tab,'gecko');check(await pending,'pending capture/script not rejected during switch');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'Gecko return');
 dump('WEBRTC Gecko after switch '+JSON.stringify(await execute(tab.linkedBrowser,source))+'\n');
 tab=win.ContentEngines.switchEngine(tab,'webkit');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'WPE return');
 api=tab.linkedBrowser.contentAPI;
 pending=api.executeScript("await navigator.mediaDevices.getUserMedia({audio:true});").then(()=>false,()=>true);
 g.removeTab(tab,{animate:false});check(await pending,'pending capture/script not rejected on close');
 let privateWin=win.OpenBrowserWindow({private:true});
 await waitFor(()=>privateWin.gBrowserInit&&privateWin.gBrowserInit.delayedStartupFinished,'private window');
 let privateTab=privateWin.ContentEngines.open(base);
 await waitFor(()=>privateTab.linkedBrowser.contentTitle=='Content fixture'&&!privateTab.hasAttribute('busy'),'private content');
 if((await privateTab.linkedBrowser.contentAPI.executeScript(source)).message!='echo:hello')failures.push('private peer transport');
 let privateCapture=await privateTab.linkedBrowser.contentAPI.executeScript("try{let s=await navigator.mediaDevices.getUserMedia({audio:true});s.getTracks().forEach(t=>t.stop());return 'granted';}catch(e){return e.name;}");
 check(privateCapture!='granted','private unsafe capture');privateWin.close();
 tab=win.ContentEngines.open(base);
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'shutdown content');
 if(Services.prefs.getBoolPref('content.test.external')) {
  tab.linkedBrowser.loadURI('https://webrtc.github.io/samples/src/content/datachannel/basic/');
  await waitFor(()=>tab.linkedBrowser.contentTitle=='Transmit text'&&!tab.hasAttribute('busy'),'public diagnostic page');
  await tab.linkedBrowser.contentAPI.executeScript("document.getElementById('startButton').click();");await delay(5000);
  dump('WEBRTC PUBLIC '+JSON.stringify(await tab.linkedBrowser.contentAPI.executeScript("return {title:document.title,startDisabled:document.getElementById('startButton').disabled,sendDisabled:document.getElementById('sendButton').disabled,received:document.getElementById('dataChannelReceive').value};"))+'\n');
  tab.linkedBrowser.loadURI(base);await waitFor(()=>tab.linkedBrowser.contentTitle=='Content fixture'&&!tab.hasAttribute('busy'),'after public diagnostic');
 }
 await tab.linkedBrowser.contentAPI.executeScript(hold);
 if(failures.length) dump('WEBRTC TRANSPORT FAILURES '+JSON.stringify(failures)+'\n');
 dump('WEBRTC PASS private, cross-origin denial, active peer crash/recovery, pending capture close/switch and active ICE shutdown\n');
 if(failures.length)throw Error(failures.join('; '));
}
