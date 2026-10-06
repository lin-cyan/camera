import { api, login, rtcConfig, startPolling } from './common.js';

const $ = id => document.getElementById(id);
let token, room, pin, pc, stopPolling;

function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

async function send(type, data = null) {
  await api(`/api/rooms/${room}/messages`, {
    token, pin, method: 'POST', body: { from: 'viewer', to: 'camera', type, data },
  });
}

async function handle(event) {
  if (event.type === 'offer') {
    pc?.close();
    pc = new RTCPeerConnection(rtcConfig);
    pc.ontrack = e => { $('video').srcObject = e.streams[0]; };
    pc.onicecandidate = e => e.candidate && send('ice', e.candidate.toJSON()).catch(console.error);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') status('已连接，视频为点对点传输', 'ok');
      else if (['failed', 'disconnected'].includes(pc.connectionState)) status('连接已中断', 'warn');
    };
    await pc.setRemoteDescription(event.data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await send('answer', pc.localDescription);
  } else if (event.type === 'ice' && pc) {
    await pc.addIceCandidate(event.data).catch(console.error);
  } else if (event.type === 'hangup') {
    pc?.close(); pc = null; $('video').srcObject = null;
    status('远端已停止共享', 'warn');
  }
}

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try {
    room = $('roomInput').value.trim().toUpperCase();
    pin = $('pinInput').value.trim();
    if (!/^[A-F0-9]{6}$/.test(room) || !/^\d{6}$/.test(pin)) throw new Error('请检查 6 位房间号和 PIN');
    token = await login($('password').value);
    stopPolling = startPolling({ token, room, pin, role: 'viewer', onEvent: handle, onError: e => status(e.message, 'warn') });
    await send('viewer-ready');
    $('form').hidden = true;
    $('disconnect').hidden = false;
    status('已验证，等待远端发送视频…');
  } catch (error) {
    status(error.message, 'bad');
    $('connect').disabled = false;
  }
});

$('disconnect').addEventListener('click', async () => {
  await send('hangup').catch(() => {});
  stopPolling?.(); pc?.close(); pc = null;
  $('video').srcObject = null;
  $('form').hidden = false; $('disconnect').hidden = true; $('connect').disabled = false;
  status('已断开');
});
