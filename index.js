const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: []
};

app.get('/', (req, res) => { /* dashboard simplifié */ res.send('Bot running - check /health'); });
app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000)
  });
});
app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, '0.0.0.0', () => console.log(`[Server] HTTP server started on port ${PORT}`));

// Self-ping
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
// BOT LOGIC
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
      checkTimeoutInterval: 300000,
      connectTimeout: 90000
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
// MODULES (remis complets)
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  console.log('[Modules] Initializing all modules...');

  if (config.utils['auto-auth'].enabled) {
    const password = config.utils['auto-auth'].password;
    setTimeout(() => {
      bot.chat(`/register ${password} ${password}`);
      bot.chat(`/login ${password}`);
      console.log('[Auth] Sent login commands');
    }, 1000);
  }

  if (config.utils['chat-messages'].enabled) {
    const messages = config.utils['chat-messages'].messages;
    let i = 0;
    setInterval(() => {
      if (bot && botState.connected) {
        bot.chat(messages[i]);
        i = (i + 1) % messages.length;
      }
    }, config.utils['chat-messages']['repeat-delay'] * 1000);
  }

  if (config.position.enabled) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  }

  if (config.utils['anti-afk'].enabled) {
    setInterval(() => {
      if (bot && botState.connected) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 150);
      }
    }, 8000);
  }

  // Ajoute ici tes autres fonctions (startCircleWalk, etc.) si besoin
  console.log('[Modules] Initialized!');
}

const setupLeaveRejoin = require('./leaveRejoin');

// START
console.log('='.repeat(50));
console.log(' Minecraft AFK Bot v2.3 - Optimized Edition');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log('='.repeat(50));

console.log('[Bot] Waiting 30 seconds for Aternos server to fully load...');
setTimeout(() => {
  createBot();
}, 30000);
