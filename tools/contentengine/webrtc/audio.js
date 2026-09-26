/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// Synthetic WebAudio media verifies codec/RTP transport without device capture.
const context=new AudioContext(), oscillator=context.createOscillator(), destination=context.createMediaStreamDestination();
const left=new RTCPeerConnection({iceServers:[]}), right=new RTCPeerConnection({iceServers:[]});
let received;
left.onicecandidate=e=>{if(e.candidate)right.addIceCandidate(e.candidate).catch(()=>{});};
right.onicecandidate=e=>{if(e.candidate)left.addIceCandidate(e.candidate).catch(()=>{});};
right.ontrack=e=>{received=e.track;};
try {
 oscillator.connect(destination);oscillator.start();
 // A synthetic muted destination is not a privileged device permission.
 const resume=context.resume();resume.catch(()=>{});
 destination.stream.getTracks().forEach(track=>left.addTrack(track,destination.stream));
 await left.setLocalDescription(await left.createOffer());await right.setRemoteDescription(left.localDescription);
 await right.setLocalDescription(await right.createAnswer());await left.setRemoteDescription(right.localDescription);
 let output,input,codecs=[];
 for(let i=0;i<50;i++){
  await new Promise(resolve=>setTimeout(resolve,100));
  (await left.getStats()).forEach(stat=>{if(stat.type=='outbound-rtp')output=stat;if(stat.type=='codec')codecs.push(stat.mimeType);});
  (await right.getStats()).forEach(stat=>{if(stat.type=='inbound-rtp')input=stat;});
  if(input&&input.packetsReceived>0)break;
 }
 return {context:context.state,track:received&&received.kind,packetsSent:output&&output.packetsSent,
   packetsReceived:input&&input.packetsReceived,codecs:Array.from(new Set(codecs))};
} catch(error){return {error:String(error),context:context.state};}
finally {oscillator.stop();destination.stream.getTracks().forEach(t=>t.stop());left.close();right.close();await context.close();}
