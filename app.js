const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const roomIdInput = document.getElementById("roomId");
const joinButton = document.getElementById("joinButton");
const leaveButton = document.getElementById("leaveButton");
const connectionStatus = document.getElementById("connectionStatus");
const muteButton = document.getElementById("muteButton");
const cameraButton = document.getElementById("cameraButton");

let localStream = null;
let remoteStream = null;
let pc = null;
let ws = null;
let room = null;
let peerId = null;
let isCaller = false;

async function fetchIceServers() {
  try {
    const res = await fetch('https://gyanendra6767-my-test-demo.hf.space/turn');
    const data = await res.json();
    return data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch (err) {
    console.warn('Turn fetch failed, using STUN fallback', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

function logStatus(text, state = 'default') {
  connectionStatus.textContent = text;
  connectionStatus.className = 'status-pill';
  if (state === 'connected') connectionStatus.classList.add('connected');
  else if (state === 'connecting') connectionStatus.classList.add('connecting');
  else if (state === 'error') connectionStatus.classList.add('error');
}

function logDebug(...args) {
  console.log(...args);
}

async function startLocalMedia() {
  try {
    logStatus('Requesting camera & microphone…', 'connecting');
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    logStatus('Local media ready');
  } catch (err) {
    logStatus('Failed to get media', 'error');
    throw err;
  }
}

function attachPcEventLogs(pc) {
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log('ICE STATE:', pc.iceConnectionState);
    logStatus(pc.iceConnectionState, pc.iceConnectionState === 'connected' ? 'connected' : pc.iceConnectionState === 'checking' ? 'connecting' : 'error');
  });
  pc.addEventListener('connectionstatechange', () => console.log('CONNECTION STATE:', pc.connectionState));
  pc.addEventListener('signalingstatechange', () => console.log('SIGNALING STATE:', pc.signalingState));
  pc.addEventListener('icegatheringstatechange', () => console.log('LOCAL ICE:', pc.iceGatheringState));
  pc.addEventListener('track', (e) => {
    console.log('REMOTE ICE: track received');
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(e.track);
  });
}

async function createPeerConnection() {
  const iceServers = await fetchIceServers();
  const config = { iceServers };
  pc = new RTCPeerConnection(config);
  attachPcEventLogs(pc);

  pc.addEventListener('icecandidate', (ev) => {
    console.log('LOCAL ICE:', ev.candidate);
    if (ev.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ice', candidate: ev.candidate }));
    }
  });

  // add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  return pc;
}

async function handleOffer(offer) {
  if (!pc) await createPeerConnection();
  logStatus('Received offer — answering...', 'connecting');
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', answer }));
}

async function handleAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
  logStatus('Connected', 'connected');
}

async function handleCandidate(candidate) {
  try {
    if (!pc) await createPeerConnection();
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.warn('addIceCandidate error', err);
  }
}

async function joinRoom() {
  const roomId = roomIdInput.value.trim();
  if (!roomId) {
    logStatus('Please enter a room id', 'error');
    return;
  }
  room = roomId;
  await startLocalMedia();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = "https://gyanendra6767-my-test-demo.hf.space/ws";
  ws = new WebSocket(wsUrl);
  console.log('Connecting to signaling server at', wsUrl);
  ws.addEventListener('open', () => {
    logStatus('Connected to signaling', 'connecting');
    ws.send(JSON.stringify({ type: 'join', room }));
  });

  ws.addEventListener('message', async (ev) => {
    const data = JSON.parse(ev.data);
    logDebug('SIGNAL:', data.type, data);
    switch (data.type) {
      case 'joined':
        peerId = data.peerId;
        isCaller = data.isCaller;
        logStatus('Joined room');
        // if you are second and isCaller=false you're the answerer; wait for ready
        break;
      case 'peer-joined':
        // other joined -- nothing to do
        break;
      case 'ready':
        // two peers present — if caller, start offer
        if (isCaller) {
          if (!pc) await createPeerConnection();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', offer }));
          logStatus('Calling — offer sent', 'connecting');
        }
        break;
      case 'offer':
        await handleOffer(data.offer);
        break;
      case 'answer':
        await handleAnswer(data.answer);
        break;
      case 'ice':
        await handleCandidate(data.candidate);
        break;
      case 'peer-left':
        logStatus('Peer left', 'error');
        if (pc) pc.close();
        pc = null;
        break;
      case 'error':
        logStatus(data.message || 'Signaling error', 'error');
        break;
      default:
        console.warn('Unknown signal', data);
    }
  });

  ws.addEventListener('close', () => {
    logStatus('Signaling disconnected', 'error');
  });

  ws.addEventListener('error', (e) => {
    console.error('WS error', e);
    logStatus('Signaling error', 'error');
  });

  joinButton.disabled = true;
  leaveButton.disabled = false;
}

async function leaveRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
  if (ws) ws.close();
  ws = null;

  if (pc) {
    pc.getSenders().forEach(s => s.track && s.track.stop());
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
  }

  joinButton.disabled = false;
  leaveButton.disabled = true;
  logStatus('Disconnected');
}

function toggleMute() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  muteButton.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
}

function toggleCamera() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  cameraButton.textContent = videoTrack.enabled ? 'Toggle Camera' : 'Enable Camera';
}

joinButton.addEventListener('click', joinRoom);
leaveButton.addEventListener('click', leaveRoom);
muteButton.addEventListener('click', toggleMute);
cameraButton.addEventListener('click', toggleCamera);

// expose for debugging
window._webrtc = { joinRoom, leaveRoom };
