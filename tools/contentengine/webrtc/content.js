/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// Runs inside the real content engine, without privileged objects or capture.
const exposed = {
  secure: isSecureContext,
  mediaDevices: typeof navigator.mediaDevices,
  getUserMedia: navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia,
  peerConnection: typeof RTCPeerConnection
};
if (typeof RTCPeerConnection != "function") return {exposed};
const left = new RTCPeerConnection({iceServers: []});
const right = new RTCPeerConnection({iceServers: []});
let candidates = 0, queues = [[], []], timer;
function candidate(from, to, queue) {
  from.onicecandidate = event => {
    if (!event.candidate) return;
    ++candidates;
    if (to.remoteDescription) to.addIceCandidate(event.candidate).catch(() => {});
    else queue.push(event.candidate);
  };
}
candidate(left, right, queues[0]); candidate(right, left, queues[1]);
try {
  const exchange = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Local data-channel timeout; ICE=" + left.iceConnectionState + "/" + right.iceConnectionState)), 15000);
    right.ondatachannel = event => {
      event.channel.onmessage = message => event.channel.send("echo:" + message.data);
    };
    const channel = left.createDataChannel("local-test");
    channel.onopen = () => channel.send("hello");
    channel.onmessage = event => resolve(event.data);
  });
  const offer = await left.createOffer(); await left.setLocalDescription(offer);
  await right.setRemoteDescription(offer);
  for (const entry of queues[0]) await right.addIceCandidate(entry);
  const answer = await right.createAnswer(); await right.setLocalDescription(answer);
  await left.setRemoteDescription(answer);
  for (const entry of queues[1]) await left.addIceCandidate(entry);
  const result = {exposed, offer:offer.type, answer:answer.type, message:await exchange,
    candidates, ice:left.iceConnectionState};
  return result;
} catch (error) { return {exposed, error:String(error), candidates, local:left.localDescription && left.localDescription.type, remote:left.remoteDescription && left.remoteDescription.type, gathering:left.iceGatheringState}; }
finally {clearTimeout(timer); left.close(); right.close();}
