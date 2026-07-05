// ─────────────────────────────────────────────
//  포트리스 미니 - 게임 서버 (다중 방 + 1:1 / 2:2 지원)
//  실행: node server.js  →  브라우저에서 http://<이 컴퓨터의 IP>:3000 접속
// ─────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const urlLib = require('url');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ── 정적 파일 서버 ──
const server = http.createServer((req, res) => {
  const pathname = urlLib.parse(req.url).pathname;
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── 방(room) 관리 ──
// 방 코드마다 독립된 로비/게임 상태를 가짐 → 여러 쌍이 동시에 플레이 가능
// mode: '1v1' (2명, 1대1) | '2v2' (4명, 앞쪽 절반 vs 뒤쪽 절반 팀전)
const rooms = new Map(); // code -> room

function newRoom(code, mode) {
  const numPlayers = mode === '2v2' ? 4 : 2;
  return {
    code,
    mode,
    numPlayers,
    players: Array(numPlayers).fill(null),
    lobby: { picks: Array(numPlayers).fill(null), ready: Array(numPlayers).fill(false), map: 0 },
    game: null,
    emptyTimer: null,
  };
}
function getOrCreateRoom(code, mode) {
  if (!rooms.has(code)) rooms.set(code, newRoom(code, mode));
  return rooms.get(code);
}
function scheduleCleanup(room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (room.players.every((p) => p === null)) rooms.delete(room.code);
  }, 5 * 60 * 1000); // 5분간 아무도 없으면 방 정리
}

// 턴 순서: 팀이 번갈아 나오도록 배치 (2v2는 [0,2,1,3] → 0/2/1/3번 슬롯 = A,B,A,B)
// 1-based 플레이어 번호 배열로 반환
function buildTurnOrder(numPlayers) {
  const half = numPlayers / 2;
  const order = [];
  for (let i = 0; i < half; i++) { order.push(i + 1); order.push(i + half + 1); }
  return order;
}

const wss = new WebSocketServer({ server });

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { room.players.forEach((p) => send(p, msg)); }
function randWind() { return Math.round((Math.random() * 16 - 8) * 10) / 10; }
function resetLobby(room) {
  room.lobby = { picks: Array(room.numPlayers).fill(null), ready: Array(room.numPlayers).fill(false), map: room.lobby.map };
  room.game = null;
}
function connCount(room) { return room.players.map((p) => !!p); }

wss.on('connection', (ws, req) => {
  const query = urlLib.parse(req.url, true).query;
  const code = String(query.room || '').toUpperCase().trim().slice(0, 8);
  const modeReq = query.mode === '2v2' ? '2v2' : '1v1';
  if (!/^[A-Z0-9]{3,8}$/.test(code)) { send(ws, { type: 'badRoom' }); ws.close(); return; }

  const room = getOrCreateRoom(code, modeReq);
  const slot = room.players.indexOf(null);
  if (slot === -1) { send(ws, { type: 'full' }); ws.close(); return; }

  room.players[slot] = ws;
  ws.slot = slot;
  ws.roomCode = code;
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }

  const team = slot < room.numPlayers / 2 ? 1 : 2;
  send(ws, { type: 'joined', playerId: slot + 1, room: code, mode: room.mode, numPlayers: room.numPlayers, team });
  broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });

  ws.on('message', (raw) => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ── 로비 ──
      case 'pick':
        room.lobby.picks[ws.slot] = msg.tank;
        room.lobby.ready[ws.slot] = false;
        broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
        break;

      case 'map': // 슬롯 0(방장)만 맵 선택 가능
        if (ws.slot === 0) {
          room.lobby.map = msg.map;
          broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
        }
        break;

      case 'ready':
        if (room.lobby.picks[ws.slot] == null) break;
        room.lobby.ready[ws.slot] = true;
        broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
        if (room.lobby.ready.every(Boolean) && room.players.every((p) => p)) {
          const turnOrder = buildTurnOrder(room.numPlayers);
          room.game = { turn: turnOrder[0] };
          broadcast(room, {
            type: 'start',
            map: room.lobby.map,
            tanks: room.lobby.picks,
            seed: Math.floor(Math.random() * 1e9),
            wind: randWind(),
            turn: room.game.turn,
            turnOrder,
            mode: room.mode,
          });
        }
        break;

      // ── 게임 중 실시간 중계 ──
      case 'move':
      case 'aim':
        broadcast(room, { type: msg.type, from: ws.slot + 1, ...msg });
        break;

      case 'fire':
        broadcast(room, { type: 'fire', from: ws.slot + 1, angle: msg.angle, power: msg.power, weapon: msg.weapon });
        break;

      // 발사한 클라이언트가 다음 턴(팀 전멸 여부 포함해 계산)을 알려주면 그대로 중계
      case 'turnDone':
        if (!room.game) break;
        room.game.turn = msg.nextTurn;
        broadcast(room, { type: 'turn', turn: msg.nextTurn, wind: randWind(), sync: msg.sync });
        break;

      case 'gameover':
        broadcast(room, { type: 'gameover', winner: msg.winner });
        resetLobby(room);
        broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
        break;

      case 'rematch':
        resetLobby(room);
        broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.players[ws.slot] = null;
    room.lobby.picks[ws.slot] = null;
    room.lobby.ready = room.lobby.ready.map(() => false);
    room.game = null;
    broadcast(room, { type: 'opponentLeft' });
    broadcast(room, { type: 'lobby', lobby: room.lobby, connected: connCount(room), mode: room.mode, numPlayers: room.numPlayers });
    scheduleCleanup(room);
  });
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('──────────────────────────────────────');
  console.log('  포트리스 미니 서버 시작! (다중 방, 1:1 / 2:2 지원)');
  console.log(`  이 컴퓨터에서:   http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  다른 컴퓨터에서: http://${ip}:${PORT}`));
  console.log('──────────────────────────────────────');
});
