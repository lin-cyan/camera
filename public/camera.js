import { api, login, rtcConfig, startPolling } from './common.js';

const $ = id => document.getElementById(id);
let token, room, pin, stream, pc, stopPolling;

function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

async function send(type, data = null) {
  await api(`/api/rooms/${room}/messages`, {
    token, pin, method: 'POST', body: { from: 'camera', to: 'viewer', type, data },
  });
}

async function makePeer() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(rtcConfig);
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
  pc.onicecandidate = event => event.candidate && send('ice', event.candidate.toJSON()).catch(console.error);
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') status('查看端已连接，正在直播', 'ok');
    else if (['failed', 'disconnected'].includes(state)) status('连接中断，等待查看端重新连接', 'warn');
  };
}

async function handle(event) {
  if (event.type === 'viewer-ready') {
    await makePeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send('offer', pc.localDescription);
    status('查看端已加入，正在建立视频连接…');
  } else if (event.type === 'answer' && pc) {
    await pc.setRemoteDescription(event.data);
  } else if (event.type === 'ice' && pc) {
    await pc.addIceCandidate(event.data).catch(console.error);
  } else if (event.type === 'hangup' && pc) {
    pc.close(); pc = null;
    status('查看端已离开，摄像头仍开启');
  }
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    token = await login($('password').value);
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      audio: false,
    });
    $('preview').srcObject = stream;
    ({ id: room, pin } = await api('/api/rooms', { token, method: 'POST' }));
    $('room').textContent = room;
    $('pin').textContent = pin;
    $('share').hidden = false;
    $('password').value = '';
    stopPolling = startPolling({ token, room, pin, role: 'camera', onEvent: handle, onError: e => status(e.message, 'warn') });
    status('摄像头已开启，等待查看端连接', 'ok');
    $('stop').disabled = false;
  } catch (error) {
    status(error.name === 'NotAllowedError' ? '未获得摄像头权限' : error.message, 'bad');
    $('start').disabled = false;
  }
});

$('stop').addEventListener('click', () => {
  stopPolling?.();
  pc?.close();
  stream?.getTracks().forEach(track => track.stop());
  $('preview').srcObject = null;
  $('share').hidden = true;
  $('start').disabled = false;
  $('stop').disabled = true;
  status('摄像头已关闭');
});

window.addEventListener('beforeunload', () => stream?.getTracks().forEach(track => track.stop()));
