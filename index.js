const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: []
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.name} Status</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; overflow: hidden; }
          .container { background: #1e293b; padding: 40px; border-radius: 20px; box-shadow: 0 0 50px rgba(45, 212, 191, 0.2); text-align: center; width: 400px; border: 1px solid #334155; }
          h1 { margin-bottom: 30px; font-size: 24px; color: #ccfbf1; display: flex; align-items: center; justify-content: center; gap: 10px; }
          .stat-card { background: #0f172a; padding: 15px; margin: 15px 0; border-radius: 12px; border-left: 5px solid #2dd4bf; text-align: left; box-shadow: 5px 5px 15px rgba(0, 0, 0, 0.3); }
          .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
          .value { font-size: 18px; font-weight: bold; color: #2dd4bf; text-shadow: 0 0 10px rgba(45, 212, 191, 0.5); margin-top: 5px; }
          .status-dot { height: 12px; width: 12px; border-radius: 50%; display: inline-block; margin-right: 8px; box-shadow: 0 0 10px currentColor; }
          .pulse { animation: pulse 2s infinite; }
          @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.1); } 100% { opacity: 1; transform: scale(1); } }
        </style>
      </head>
      <body>
        <div class="container" id="main-container">
          <h1><span id="live-indicator" class="status-dot pulse" style="color: #ef4444;"></span> ${config.name}</h1>
          <div class="stat-card"><div class="label">Status</div><div class="value" id="status-text">Connecting...</div></div>
          <div class="stat-card"><div class="label">Uptime</div><div class="value" id="uptime-text">0h 0m 0s</div></div>
          <div class="stat-card"><div class="label">Coordinates</div><div class="value" id="coords-text">Waiting...</div></div>
          <div class="stat-card"><div class="label">Server</div><div class="value">${config.server.ip}</div></div>
        </div>
        <script>
          const formatUptime = (seconds) => { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60; return \`\${h}h \${m}m \${s}s\`; };
          const updateStats = async () => {
            try {
              const res = await fetch('/health');
              const data = await res.json();
              const statusText = document.getElementById('status-text');
              const uptimeText = document.getElementById('uptime-text');
              const coordsText = document.getElementById('coords-text');
              const liveDot = document.getElementById('live-indicator');
              if (data.status === 'connected') {
                statusText.innerHTML = '<span class="status-dot" style="color: #4ade80;"></span> Online & Running';
                liveDot.style.color = '#4ade80';
              } else {
                statusText.innerHTML = '<span class="status-dot" style="color: #f87171;"></span> Reconnecting...';
                liveDot.style.color = '#f87171';
              }
              uptimeText.innerText = formatUptime(data.uptime);
              if (data.coords) coordsText.innerText = \`Coords: \${Math.floor(data.coords.x)}, \${Math.floor(data.coords.y)}, \${Math.floor(data.coords.z)}\`;
            } catch (e) {
              document.getElementById('status-text').innerText = 'System Offline';
            }
          };
          setInterval(updateStats, 1000);
          updateStats();
        </script>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    reconnectAttempts: botState.reconnectAttempts
  });
});

app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, '0.0.0.0', () => console.log(`[Server] HTTP server started on port ${PORT}`));

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// SELF-PING
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;
const https = require('https');
function startSelfPing() {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/ping`, () => {}).on('error', () => {});
  }, SELF_PING_INTERVAL);
}
startSelfPing();

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeout = null;
let isReconnecting = false;

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function getReconnectDelay() {
  const baseDelay = config.utils['auto-reconnect-delay'] || 2000;
  const maxDelay = config.utils['max-reconnect-delay'] || 60000;
  const delay = Math.min(baseDelay + (botState.reconnectAttempts * 2000), maxDelay);
  return delay;
}

function createBot() {
  if (isReconnecting) return;

  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (e) {}
    bot = null;
  }

  console.log(`[Bot] Creating bot instance...`);
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      hideErrors: false,
      checkTimeoutInterval: 300000,   // 5 minutes
      connectTimeout: 90000           // 90 secondes
    });

    bot.loadPlugin(pathfinder);

    const connectionTimeout = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received (3min)');
        scheduleReconnect();
      }
    }, 180000);

    bot.once('spawn', () => {
      clearTimeout(connectionTimeout);
      botState.connected = true;
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      console.log(`[Bot] [+] Successfully spawned on server!`);

      const mcData = require('minecraft-data')(config.server.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;

      initializeModules(bot, mcData, defaultMove);
      setupLeaveRejoin(bot, createBot);
    });

    bot.on('end', () => {
      botState.connected = false;
      clearAllIntervals();
      if (config.utils['auto-reconnect']) scheduleReconnect();
    });

    bot.on('kicked', (reason) => {
      botState.connected = false;
      console.log(`[Bot] Kicked: ${reason}`);
      if (config.utils['auto-reconnect']) scheduleReconnect();
    });

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.message}`);
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (isReconnecting) return;

  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// Le reste du code (modules, etc.) reste identique
// ============================================================
// ... (je garde le reste de ton code original pour ne pas tout réécrire, mais les parties principales sont mises à jour)

console.log('='.repeat(50));
console.log(' Minecraft AFK Bot v2.3 - Optimized Edition');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log(`Version: ${config.server.version}`);
console.log('='.repeat(50));

console.log('[Bot] Waiting 30 seconds for Aternos server to fully load...');
setTimeout(() => {
  createBot();
}, 30000);
