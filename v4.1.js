/* ═══════════════════════════════════════════════════════════════
   DARK CHAT v4.1 — ENHANCED VISITOR TRACKING
   NEW:
   ✅ Full IP + ISP + ASN tracking (ipwho.is)
   ✅ GPS Geolocation with Google Maps link
   ✅ Battery % + charging status
   ✅ Device fingerprint (OS, browser, screen, RAM, cores)
   ✅ Network type + downlink speed
   ✅ Timezone + language + referrer
   ✅ Telegram inline keyboard: /block /unblock copy buttons
   ✅ Session duration tracking
   ✅ Canvas fingerprint hash
   PREV FIXES:
   ✅ Duplicate message prevention (seenUpdateIds + offset)
   ✅ Echo filtering (own sent msgs not shown twice)
   ✅ 1s default poll speed (super fast)
   ✅ seenUpdateIds memory cap (no leak)
   ✅ Admin poll at 3s (no Telegram rate-limit)
   ✅ fetchMessages AbortController timeout
   ✅ sendMessage queue to prevent double-sends
═══════════════════════════════════════════════════════════════ */

// ── CONFIG ──────────────────────────────────────────────────────
const BOT_TOKEN  = "7584366431:AAEP0bSnUexMGFxT923ek66wYlenBD9i2ZA";
const BOT2_TOKEN = "8697203132:AAEaTOvW9y-BYHxaFMUUzwrc9dcGaYyfg8M";
const CHAT_ID    = "5870161553";

const LS_NAME      = "darkChatUserName";
const LS_LASTLOGIN = "darkChatLastLogin";
const LS_BLOCKED   = "darkChatBlocked";
const LS_SHUTDOWN  = "darkChatShutdown";
const LS_VISITORS  = "darkChatVisitors";
const CURRENT_URL  = window.location.href;

// ── SESSION OFFSET ────────────────────────────────────────────────
// FIX: Initialize from stored offset immediately so we never re-show old messages
function getStoredOffset() {
  try { return parseInt(sessionStorage.getItem('dc_offset') || '0', 10); } catch(e) { return 0; }
}
function setStoredOffset(id) {
  try { sessionStorage.setItem('dc_offset', String(id)); } catch(e) {}
}

// ── WEB AUDIO ─────────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {} }
  return audioCtx;
}
function playBeep(freq, dur, type = 'sine', vol = 0.18) {
  try {
    const ctx = getAudioCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch(e) {}
}
function playSendSound()    { if (!soundEnabled) return; playBeep(700, 0.08); setTimeout(() => playBeep(1000, 0.1, 'sine', 0.10), 70); }
function playReceiveSound() { if (!soundEnabled) return; playBeep(880, 0.12); setTimeout(() => playBeep(1100, 0.12, 'sine', 0.10), 120); }

// ── BACKGROUND MUSIC ──────────────────────────────────────────────
const bgMusic = new Audio('sound/dark1.mp3');
bgMusic.loop = true; bgMusic.volume = 0.28;

// ── DOM REFS ──────────────────────────────────────────────────────
const noticeBoard      = document.getElementById("noticeBoard");
const userInput        = document.getElementById("userInput");
const sendBtn          = document.getElementById("sendBtn");
const menuBtn          = document.getElementById("menuBtn");
const menu             = document.getElementById("menu");
const namePrompt       = document.getElementById("namePrompt");
const nameInput        = document.getElementById("nameInput");
const startChatBtn     = document.getElementById("startChatBtn");
const profileModal     = document.getElementById("profileModal");
const settingsModal    = document.getElementById("settingsModal");
const webviewContainer = document.getElementById("webviewContainer");
const webviewFrame     = document.getElementById("webviewFrame");
const webviewTitle     = document.getElementById("webviewTitle");
const typingIndicator  = document.getElementById("typingIndicator");
const emojiPicker      = document.getElementById("emojiPicker");
const charCount        = document.getElementById("charCount");
const toastEl          = document.getElementById("toast");
const returningCard    = document.getElementById("returningUserCard");
const newUserForm      = document.getElementById("newUserForm");
const returningNameEl  = document.getElementById("returningName");
const lastLoginInfoEl  = document.getElementById("lastLoginInfo");
const quickConnectBtn  = document.getElementById("quickConnectBtn");
const checkingOverlay  = document.getElementById("checkingOverlay");
const blockedPage      = document.getElementById("blockedPage");
const shutdownPage     = document.getElementById("shutdownPage");

// ── STATE ─────────────────────────────────────────────────────────
let userName = "", loginTime = "";
// FIX: Initialize lastUpdateId from stored offset at declaration time
let lastUpdateId = getStoredOffset();

// FIX: seenUpdateIds with size cap to prevent memory leak
let _seenIds = new Set();
function hasSeen(id) { return _seenIds.has(id); }
function markSeen(id) {
  _seenIds.add(id);
  // Cap at 500 entries — drop oldest half
  if (_seenIds.size > 500) {
    const arr = [..._seenIds];
    _seenIds = new Set(arr.slice(250));
  }
}

// Track update IDs of messages we sent ourselves (to filter echoes)
const _ownSentIds = new Set();

let processing = false, chatInitialized = false;
let pollInterval, pollSpeed = 1000, adminPollInterval; // FIX: 1s default
let blockedUsers = new Set(), shutdownMode = false;
let _adminFetching = false;
let notificationEnabled = true, bgMusicEnabled = false, soundEnabled = true;
let ttsEnabled = true, showTimestamps = true, compactMode = false, desktopNotifEnabled = false;
let isWebviewMinimized = false, speechQueue = [], isSpeaking = false;
let currentUtterance = null, selectedVoice = null, toastTimer = null;

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg, duration = 2400) {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.textContent = msg; toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ── TTS ───────────────────────────────────────────────────────────
function initTTS() {
  function loadVoices() {
    try {
      const v = speechSynthesis.getVoices();
      const prefer = ['Samantha','Google US English','Microsoft Zira Desktop','Zira'];
      for (const n of prefer) { selectedVoice = v.find(x => x.name.includes(n)); if (selectedVoice) break; }
      if (!selectedVoice) selectedVoice = v.find(x => x.lang && x.lang.startsWith('en') && x.name.toLowerCase().includes('female'));
      if (!selectedVoice) selectedVoice = v.find(x => x.lang && x.lang.startsWith('en')) || v[0];
    } catch(e) {}
  }
  if ('onvoiceschanged' in speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
  [300, 800, 1600].forEach(d => setTimeout(loadVoices, d));
}
function speakText(text) {
  if (!ttsEnabled || !text || !text.trim() || document.hidden) return;
  const clean = text.replace(/<[^>]*>/g, '').replace(/https?:\/\/[^\s]+/g, 'link').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) return;
  speechQueue.push(clean); processSpeechQueue();
}
function processSpeechQueue() {
  if (isSpeaking || !speechQueue.length) return;
  isSpeaking = true;
  const text = speechQueue.shift();
  speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.rate = 0.88; currentUtterance.pitch = 1.1;
  currentUtterance.volume = 0.9; currentUtterance.lang = 'en-US';
  if (selectedVoice) currentUtterance.voice = selectedVoice;
  currentUtterance.onend  = () => { isSpeaking = false; currentUtterance = null; processSpeechQueue(); };
  currentUtterance.onerror = () => { isSpeaking = false; currentUtterance = null; setTimeout(processSpeechQueue, 300); };
  try { speechSynthesis.speak(currentUtterance); } catch(e) { isSpeaking = false; }
}

// ── VISITOR TRACKING ──────────────────────────────────────────────
function getVisitorLog() { try { return JSON.parse(localStorage.getItem(LS_VISITORS) || '{}'); } catch(e) { return {}; } }
function saveVisitorLog(log) { try { localStorage.setItem(LS_VISITORS, JSON.stringify(log)); } catch(e) {} }
function registerVisitor(name) {
  const log = getVisitorLog(), ts = new Date().toISOString(), key = name.toLowerCase();
  log[key] = { name, firstSeen: log[key]?.firstSeen || ts, lastSeen: ts };
  saveVisitorLog(log);
}

// ═══════════════════════════════════════════════════════════════
//  TRACKING COLLECTORS
//  All collectors are independent — failure of one never
//  breaks another. All run in parallel via Promise.allSettled.
// ═══════════════════════════════════════════════════════════════

/* ── IP Intelligence ─────────────────────────────────────────── */
async function getIPData() {
  // Primary: ipwho.is (free, no key, returns flag + security info)
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch('https://ipwho.is/', { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error('ipwho non-ok');
    const d = await res.json();
    if (!d.success && d.success !== undefined) throw new Error('ipwho failed');
    return { source: 'ipwho', ...d };
  } catch (_) {}

  // Fallback 1: ip-api.com (free, no key)
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch('http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,query', { signal: ctrl.signal });
    clearTimeout(tid);
    const d = await res.json();
    if (d.status !== 'success') throw new Error('ip-api failed');
    return {
      source:       'ip-api',
      ip:           d.query,
      country:      d.country,
      country_code: d.countryCode,
      region:       d.regionName,
      city:         d.city,
      postal:       d.zip,
      latitude:     d.lat,
      longitude:    d.lon,
      timezone:     d.timezone,
      connection:   { isp: d.isp, org: d.org, asn: d.as },
      security:     { proxy: d.proxy, hosting: d.hosting }
    };
  } catch (_) {}

  // Fallback 2: ipapi.co
  try {
    const res = await fetch('https://ipapi.co/json/');
    const d   = await res.json();
    return {
      source:       'ipapi.co',
      ip:           d.ip,
      country:      d.country_name,
      country_code: d.country_code,
      region:       d.region,
      city:         d.city,
      postal:       d.postal,
      latitude:     d.latitude,
      longitude:    d.longitude,
      timezone:     d.timezone,
      connection:   { isp: d.org, asn: d.asn },
      security:     {}
    };
  } catch (_) { return null; }
}

/* ── Battery Status ──────────────────────────────────────────── */
async function getBatteryData() {
  try {
    if (typeof navigator.getBattery !== 'function') return null;
    const bat = await navigator.getBattery();
    return {
      level:           Math.round(bat.level * 100),
      charging:        bat.charging,
      chargingTime:    isFinite(bat.chargingTime)    ? bat.chargingTime    : null,
      dischargingTime: isFinite(bat.dischargingTime) ? bat.dischargingTime : null
    };
  } catch (_) { return null; }
}

/* ── GPS Geolocation ─────────────────────────────────────────── */
function getGeoLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 7000);
    navigator.geolocation.getCurrentPosition(
      pos => {
        clearTimeout(timer);
        resolve({
          lat:      pos.coords.latitude.toFixed(6),
          lng:      pos.coords.longitude.toFixed(6),
          alt:      pos.coords.altitude     != null ? pos.coords.altitude.toFixed(1) + 'm'   : null,
          speed:    pos.coords.speed        != null ? pos.coords.speed.toFixed(2)    + ' m/s' : null,
          heading:  pos.coords.heading      != null ? pos.coords.heading.toFixed(1)  + '°'    : null,
          accuracy: Math.round(pos.coords.accuracy),
          altAccuracy: pos.coords.altitudeAccuracy != null ? Math.round(pos.coords.altitudeAccuracy) + 'm' : null
        });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 6500, maximumAge: 30000 }
    );
  });
}

/* ── Network Connection ──────────────────────────────────────── */
function getNetworkData() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return null;
    return {
      effectiveType: (c.effectiveType || '—').toUpperCase(),
      type:          c.type          || '—',
      downlink:      c.downlink      != null ? c.downlink    + ' Mbps' : '—',
      downlinkMax:   c.downlinkMax   != null ? c.downlinkMax + ' Mbps' : '—',
      rtt:           c.rtt           != null ? c.rtt         + ' ms'   : '—',
      saveData:      c.saveData      ? 'YES (Data Saver ON)' : 'NO'
    };
  } catch (_) { return null; }
}

/* ── Canvas Fingerprint ──────────────────────────────────────── */
function getCanvasFingerprint() {
  try {
    const cv  = document.createElement('canvas');
    cv.width  = 280; cv.height = 60;
    const ctx = cv.getContext('2d');
    // Render unique combination that differs by GPU/driver
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = 'rgba(255,100,0,0.8)';
    ctx.fillRect(10, 10, 260, 40);
    ctx.font         = 'bold 16px "Arial"';
    ctx.fillStyle    = '#00c8ff';
    ctx.fillText('DarkChat \uD83D\uDD10 Fingerprint', 12, 32);
    ctx.font         = '12px "Courier New"';
    ctx.fillStyle    = 'rgba(0,255,136,0.85)';
    ctx.fillText(navigator.userAgent.slice(0, 50), 12, 52);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle    = 'rgba(100,0,255,0.4)';
    ctx.fillRect(150, 5, 100, 25);
    const raw = cv.toDataURL('image/webp', 0.8);
    // djb2-style hash → 8-char hex
    let h = 5381;
    for (let i = 0; i < raw.length; i++) { h = ((h << 5) + h) ^ raw.charCodeAt(i); h |= 0; }
    return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  } catch (_) { return 'UNAVAILABLE'; }
}

/* ── Device + Browser Info ───────────────────────────────────── */
function getDeviceInfo() {
  const ua = navigator.userAgent || '';
  let os = 'Unknown', browser = 'Unknown', browserVer = '';

  // ── OS ────────────────────────────────────────────────────────
  if      (/Windows NT 10\.0/.test(ua))              os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(ua))               os = 'Windows 8.1';
  else if (/Windows NT 6\.2/.test(ua))               os = 'Windows 8';
  else if (/Windows NT 6\.1/.test(ua))               os = 'Windows 7';
  else if (/Windows NT 6\.0/.test(ua))               os = 'Windows Vista';
  else if (/Windows NT 5\.1/.test(ua))               os = 'Windows XP';
  else if (/CrOS/.test(ua))                          os = 'ChromeOS';
  else if (/Android ([\d.]+)/.test(ua))              os = `Android ${RegExp.$1}`;
  else if (/iPhone OS ([\d_]+)/.test(ua))            os = `iOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/iPad.*OS ([\d_]+)/.test(ua))             os = `iPadOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/Mac OS X ([\d_.]+)/.test(ua))            os = `macOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/Ubuntu/.test(ua))                        os = 'Ubuntu Linux';
  else if (/Linux/.test(ua))                         os = 'Linux';
  else if (/FreeBSD/.test(ua))                       os = 'FreeBSD';

  // ── Browser ───────────────────────────────────────────────────
  if      (/Edg\/([\d.]+)/.test(ua))                { browser = 'Microsoft Edge';   browserVer = RegExp.$1; }
  else if (/OPR\/([\d.]+)/.test(ua))                { browser = 'Opera';            browserVer = RegExp.$1; }
  else if (/YaBrowser\/([\d.]+)/.test(ua))           { browser = 'Yandex Browser';  browserVer = RegExp.$1; }
  else if (/SamsungBrowser\/([\d.]+)/.test(ua))      { browser = 'Samsung Browser'; browserVer = RegExp.$1; }
  else if (/UCBrowser\/([\d.]+)/.test(ua))           { browser = 'UC Browser';      browserVer = RegExp.$1; }
  else if (/Firefox\/([\d.]+)/.test(ua))             { browser = 'Firefox';         browserVer = RegExp.$1; }
  else if (/Chrome\/([\d.]+)/.test(ua))              { browser = 'Chrome';          browserVer = RegExp.$1; }
  else if (/Version\/([\d.]+).*Safari/.test(ua))    { browser = 'Safari';          browserVer = RegExp.$1; }

  // ── Device Type ───────────────────────────────────────────────
  const isMobile  = /Mobile|Android(?!.*Tablet)|iPhone/.test(ua);
  const isTablet  = /iPad|Tablet|Android(?=.*Tablet)/.test(ua);
  const deviceType = isTablet ? '📱 Tablet' : isMobile ? '📱 Mobile' : '🖥️ Desktop';

  // ── Timezone offset string ────────────────────────────────────
  const tzRaw    = new Date().getTimezoneOffset();
  const tzSign   = tzRaw <= 0 ? '+' : '-';
  const tzHours  = Math.floor(Math.abs(tzRaw) / 60).toString().padStart(2, '0');
  const tzMins   = (Math.abs(tzRaw) % 60).toString().padStart(2, '0');
  const tzOffset = `UTC${tzSign}${tzHours}:${tzMins}`;

  // ── Screen color depth ────────────────────────────────────────
  const colorDepth = window.screen.colorDepth ? `${window.screen.colorDepth}-bit` : '—';

  return {
    os, browser,
    browserFull: browserVer ? `${browser} v${browserVer}` : browser,
    deviceType,
    isMobile: isMobile || isTablet,

    // Display
    screenRes:   `${window.screen.width} × ${window.screen.height}`,
    viewport:    `${window.innerWidth} × ${window.innerHeight}`,
    dpr:         `${window.devicePixelRatio || 1}x`,
    colorDepth,
    orientation: (screen.orientation?.type || '—').replace('-', ' '),

    // Hardware
    ram:         navigator.deviceMemory     ? `${navigator.deviceMemory} GB`   : '—',
    cores:       navigator.hardwareConcurrency || '—',
    touchPoints: navigator.maxTouchPoints   || 0,
    platform:    navigator.platform         || '—',
    vendor:      navigator.vendor           || '—',

    // Locale
    language:    navigator.language         || '—',
    languages:   (navigator.languages       || []).slice(0, 4).join(', ') || '—',
    timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone || '—',
    tzOffset,

    // Privacy / Misc
    cookiesEnabled:   navigator.cookieEnabled,
    doNotTrack:       navigator.doNotTrack === '1' ? '🚫 YES' : '✅ NO',
    onLine:           navigator.onLine,
    pdfViewer:        navigator.pdfViewerEnabled != null ? (navigator.pdfViewerEnabled ? 'YES' : 'NO') : '—',
    referrer:         document.referrer || 'Direct / None',
    pageTitle:        document.title    || '—',

    // Storage
    localStorageOk:   (() => { try { localStorage.setItem('_t','1'); localStorage.removeItem('_t'); return 'YES'; } catch(_) { return 'NO'; } })(),
  };
}

/* ── Battery Format Helper ───────────────────────────────────── */
function formatBattery(bat) {
  if (!bat) return 'Not available (API blocked or desktop)';
  const pct  = bat.level;
  const icon = bat.charging           ? '⚡'
             : pct >= 80              ? '🔋'
             : pct >= 40              ? '🟡'
             : pct >= 15              ? '🪫'
             :                          '🔴';
  const barFilled = Math.round(pct / 10);
  const bar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
  let out = `${icon} ${pct}%  [${bar}]  ${bat.charging ? 'CHARGING ⚡' : 'ON BATTERY'}`;
  if (!bat.charging && bat.dischargingTime) {
    const h = Math.floor(bat.dischargingTime / 3600);
    const m = Math.floor((bat.dischargingTime % 3600) / 60);
    out += `\n⏱️ Time remaining : ~${h}h ${m}m`;
  }
  if (bat.charging && bat.chargingTime) {
    const h = Math.floor(bat.chargingTime / 3600);
    const m = Math.floor((bat.chargingTime % 3600) / 60);
    out += `\n⏱️ Full charge in  : ~${h}h ${m}m`;
  }
  return out;
}

/* ── Session Timing ──────────────────────────────────────────── */
const _sessionStart = Date.now();
function getSessionAge() {
  const secs = Math.round((Date.now() - _sessionStart) / 1000);
  if (secs < 60)  return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN REPORT FUNCTION — sends full dossier to Bot 2
//  Uses Promise.allSettled so GPS/battery failure = no crash
// ═══════════════════════════════════════════════════════════════
async function reportVisitorToBot2(name, isReturning) {
  const prevName = (localStorage.getItem(LS_NAME) || '').trim();
  const status   = isReturning ? '♻️ RETURNING USER' : '🆕 NEW USER';
  const nameKey  = name.toLowerCase().slice(0, 32); // Telegram callback_data limit

  const loginAt = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });

  // ── Sync collectors (instant) ──────────────────────────────────
  const device      = getDeviceInfo();
  const net         = getNetworkData();
  const fingerprint = getCanvasFingerprint();

  // ── Async collectors (parallel, max ~7s total) ─────────────────
  const [ipRes, batRes, geoRes] = await Promise.allSettled([
    getIPData(),
    getBatteryData(),
    getGeoLocation()
  ]);
  const ipData  = ipRes.status  === 'fulfilled' ? ipRes.value  : null;
  const battery = batRes.status === 'fulfilled' ? batRes.value : null;
  const geo     = geoRes.status === 'fulfilled' ? geoRes.value : null;

  // ── Build message ──────────────────────────────────────────────
  const D  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';  // section divider
  const NL = '\n';
  const pad = (label, val) => `${label.padEnd(16)}: ${val}`;

  let msg = '';

  // ╔══ HEADER ══╗
  msg += `🟢 DARK CHAT — VISITOR ALERT${NL}`;
  msg += `${D}${NL}`;

  // ── IDENTITY ──────────────────────────────────────────────────
  msg += `👤 ${pad('NAME',       name.toUpperCase())}${NL}`;
  msg += `📊 ${pad('STATUS',     status)}${NL}`;
  if (isReturning && prevName && prevName.toLowerCase() !== nameKey) {
    msg += `🔄 ${pad('PREV NAME', prevName)}${NL}`;
  }
  msg += `🕐 ${pad('LOGIN TIME', loginAt)}${NL}`;
  msg += `⌛ ${pad('SESSION AGE', getSessionAge())}${NL}`;
  msg += `🌐 ${pad('PAGE URL',  CURRENT_URL.split('?')[0])}${NL}`;
  msg += `🔗 ${pad('REFERRER',  device.referrer)}${NL}`;
  msg += `📄 ${pad('PAGE TITLE', device.pageTitle)}${NL}`;
  msg += `${D}${NL}`;

  // ── IP INTELLIGENCE ───────────────────────────────────────────
  if (ipData) {
    const flag   = ipData.flag?.emoji || '';
    const isp    = ipData.connection?.isp    || ipData.isp    || ipData.org || '—';
    const org    = ipData.connection?.org    || ipData.org    || '—';
    const asn    = ipData.connection?.asn    || ipData.asn    || '—';
    const isVPN  = ipData.security?.vpn  || ipData.security?.proxy || ipData.proxy || false;
    const isBot  = ipData.security?.bot  || false;
    const isHost = ipData.security?.hosting || ipData.hosting || false;

    msg += `🌍 ${pad('IP ADDRESS',  ipData.ip || '—')}${NL}`;
    msg += `🏳️ ${pad('COUNTRY',    `${flag} ${ipData.country || ipData.country_name || '—'} (${ipData.country_code || '—'})`)}${NL}`;
    msg += `🏙️ ${pad('CITY',       `${ipData.city || '—'}, ${ipData.region || ipData.region_name || '—'}`)}${NL}`;
    msg += `📮 ${pad('POSTAL',     ipData.postal || ipData.zip || '—')}${NL}`;
    msg += `🕰️ ${pad('IP TIMEZONE', ipData.timezone || '—')}${NL}`;
    if (ipData.latitude && ipData.longitude) {
      msg += `🗺️ ${pad('IP COORDS',  `${Number(ipData.latitude).toFixed(4)}, ${Number(ipData.longitude).toFixed(4)}`)}${NL}`;
      msg += `🗺️ IP MAP     : https://maps.google.com/?q=${Number(ipData.latitude).toFixed(6)},${Number(ipData.longitude).toFixed(6)}${NL}`;
    }
    msg += `🏢 ${pad('ISP',        isp)}${NL}`;
    msg += `🔌 ${pad('ASN',        asn)}${NL}`;
    msg += `🕸️ ${pad('ORG',        org)}${NL}`;
    msg += `🔒 ${pad('VPN/PROXY',  isVPN  ? '⚠️ DETECTED'  : '✅ Clean')}${NL}`;
    msg += `🤖 ${pad('BOT FLAG',   isBot  ? '⚠️ YES'       : '✅ NO'  )}${NL}`;
    msg += `🏠 ${pad('HOSTING IP', isHost ? '⚠️ YES'       : '✅ NO'  )}${NL}`;
    msg += `📡 ${pad('DATA SRC',   ipData.source || '—')}${NL}`;
  } else {
    msg += `🌍 IP INTELLIGENCE : Fetch failed (network/CORS)${NL}`;
  }
  msg += `${D}${NL}`;

  // ── GPS LOCATION ──────────────────────────────────────────────
  if (geo) {
    msg += `📍 ${pad('GPS LAT',    geo.lat)}${NL}`;
    msg += `📍 ${pad('GPS LNG',    geo.lng)}${NL}`;
    msg += `🎯 ${pad('ACCURACY',   `±${geo.accuracy}m`)}${NL}`;
    if (geo.alt)     msg += `⛰️ ${pad('ALTITUDE',   geo.alt)}${NL}`;
    if (geo.speed)   msg += `💨 ${pad('SPEED',      geo.speed)}${NL}`;
    if (geo.heading) msg += `🧭 ${pad('HEADING',    geo.heading)}${NL}`;
    msg += `🗺️ GOOGLE MAP : https://maps.google.com/?q=${geo.lat},${geo.lng}${NL}`;
    msg += `📌 OSM MAP   : https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lng}&zoom=17${NL}`;
  } else {
    msg += `📍 GPS LOCATION   : Permission denied / not supported${NL}`;
  }
  msg += `${D}${NL}`;

  // ── BATTERY ───────────────────────────────────────────────────
  msg += `🔋 BATTERY STATUS:${NL}`;
  msg += `   ${formatBattery(battery)}${NL}`;
  msg += `${D}${NL}`;

  // ── DEVICE ────────────────────────────────────────────────────
  msg += `💻 ${pad('DEVICE TYPE', device.deviceType)}${NL}`;
  msg += `🖥️ ${pad('OS',         device.os)}${NL}`;
  msg += `🌐 ${pad('BROWSER',    device.browserFull)}${NL}`;
  msg += `📐 ${pad('SCREEN',     device.screenRes)}${NL}`;
  msg += `🪟 ${pad('VIEWPORT',   device.viewport)}${NL}`;
  msg += `🔍 ${pad('DPR',        device.dpr)}${NL}`;
  msg += `🎨 ${pad('COLOR DEPTH', device.colorDepth)}${NL}`;
  msg += `📱 ${pad('ORIENTATION', device.orientation)}${NL}`;
  msg += `🧠 ${pad('RAM',        device.ram)}${NL}`;
  msg += `⚙️ ${pad('CPU CORES',  String(device.cores))}${NL}`;
  msg += `👆 ${pad('TOUCH PTS',  String(device.touchPoints))}${NL}`;
  msg += `🖥️ ${pad('PLATFORM',   device.platform)}${NL}`;
  msg += `🏭 ${pad('VENDOR',     device.vendor)}${NL}`;
  msg += `📄 ${pad('PDF VIEWER', device.pdfViewer)}${NL}`;
  msg += `${D}${NL}`;

  // ── LOCALE / PRIVACY ──────────────────────────────────────────
  msg += `🌍 ${pad('LANGUAGE',   device.language)}${NL}`;
  msg += `🌐 ${pad('LANGUAGES',  device.languages)}${NL}`;
  msg += `🕰️ ${pad('TIMEZONE',  device.timezone)}${NL}`;
  msg += `🔢 ${pad('TZ OFFSET',  device.tzOffset)}${NL}`;
  msg += `🍪 ${pad('COOKIES',    device.cookiesEnabled ? '✅ Enabled' : '❌ Disabled')}${NL}`;
  msg += `💾 ${pad('LOCAL STOR', device.localStorageOk)}${NL}`;
  msg += `🚫 ${pad('DO NOT TRACK', device.doNotTrack)}${NL}`;
  msg += `📡 ${pad('ONLINE',     device.onLine ? '✅ YES' : '❌ NO')}${NL}`;
  msg += `${D}${NL}`;

  // ── NETWORK ───────────────────────────────────────────────────
  if (net) {
    msg += `📶 ${pad('NET TYPE',    net.effectiveType)}${NL}`;
    msg += `🔌 ${pad('INTERFACE',   net.type)}${NL}`;
    msg += `⚡ ${pad('DOWNLINK',    net.downlink)}${NL}`;
    msg += `🚀 ${pad('MAX DL',      net.downlinkMax)}${NL}`;
    msg += `🏓 ${pad('LATENCY RTT', net.rtt)}${NL}`;
    msg += `💾 ${pad('DATA SAVER',  net.saveData)}${NL}`;
  } else {
    msg += `📶 NETWORK INFO    : Network API unavailable${NL}`;
  }
  msg += `${D}${NL}`;

  // ── FINGERPRINT ───────────────────────────────────────────────
  msg += `🔑 ${pad('CANVAS FP',  fingerprint)}${NL}`;
  msg += `🔒 USER AGENT:${NL}`;
  // Break UA into 2 lines if long
  const ua = navigator.userAgent;
  msg += `   ${ua.slice(0, 100)}${NL}`;
  if (ua.length > 100) msg += `   ${ua.slice(100, 200)}${NL}`;
  msg += `${D}${NL}`;

  // ── ADMIN COMMANDS ────────────────────────────────────────────
  msg += `⚡ ADMIN COMMANDS:${NL}`;
  msg += `/block ${nameKey}${NL}`;
  msg += `/unblock ${nameKey}${NL}`;
  msg += `/shutdown-sy   ← shutdown chat${NL}`;
  msg += `/shutdown-off  ← restore chat`;

  // ── Telegram inline keyboard ───────────────────────────────────
  // copy_text = Bot API 7.3+ — tapping the button copies the text to clipboard
  // Works without any webhook. Falls back to url buttons for older clients.
  const kbd = {
    inline_keyboard: [
      // Row 1 — Quick action buttons
      [
        {
          text: `🚫 BLOCK ${name.toUpperCase()}`,
          callback_data: `block_${nameKey}`   // triggers bot's message handler
        },
        {
          text: `✅ UNBLOCK ${name.toUpperCase()}`,
          callback_data: `unblock_${nameKey}`
        }
      ],
      // Row 2 — Copy command to clipboard (Bot API 7.3+)
      [
        {
          text: `📋 Copy /block ${nameKey}`,
          copy_text: { text: `/block ${nameKey}` }
        },
        {
          text: `📋 Copy /unblock ${nameKey}`,
          copy_text: { text: `/unblock ${nameKey}` }
        }
      ],
      // Row 3 — Shutdown / Restore
      [
        {
          text: '📋 Copy /shutdown-sy',
          copy_text: { text: '/shutdown-sy' }
        },
        {
          text: '📋 Copy /shutdown-off',
          copy_text: { text: '/shutdown-off' }
        }
      ],
      // Row 4 — Open map if GPS available
      ...(geo ? [[
        {
          text: '🗺️ Open Live Location',
          url: `https://maps.google.com/?q=${geo.lat},${geo.lng}`
        }
      ]] : [])
    ]
  };

  // Telegram hard limit = 4096 chars — smart truncate at section boundary
  const MAX = 4090;
  const finalMsg = msg.length > MAX
    ? msg.slice(0, MAX).replace(/\n[^\n]*$/, '') + '\n...[TRUNCATED — message too long]'
    : msg;

  // ── POST — try with inline keyboard first, then plain fallback ─
  const send = async (body) => {
    const r = await fetch(`https://api.telegram.org/bot${BOT2_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.description || `HTTP ${r.status}`); }
    return r.json();
  };

  try {
    await send({
      chat_id:      CHAT_ID,
      text:         finalMsg,
      reply_markup: kbd,
      disable_web_page_preview: true
    });
  } catch (e1) {
    // Fallback A: drop copy_text (older Bot API)
    try {
      const kbdSimple = {
        inline_keyboard: [
          [
            { text: `🚫 BLOCK ${name.toUpperCase()}`,   callback_data: `block_${nameKey}`   },
            { text: `✅ UNBLOCK ${name.toUpperCase()}`, callback_data: `unblock_${nameKey}` }
          ],
          ...(geo ? [[{ text: '🗺️ Open Location', url: `https://maps.google.com/?q=${geo.lat},${geo.lng}` }]] : [])
        ]
      };
      await send({ chat_id: CHAT_ID, text: finalMsg, reply_markup: kbdSimple, disable_web_page_preview: true });
    } catch (e2) {
      // Fallback B: no keyboard at all
      try { await send({ chat_id: CHAT_ID, text: finalMsg, disable_web_page_preview: true }); } catch (_) {}
    }
  }
}

// ── ADMIN BOT2 — Block / Unblock / Shutdown ───────────────────────
async function fetchAdminCommands(silent = false) {
  if (_adminFetching) return;
  _adminFetching = true;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 4000);
    const res  = await fetch(`https://api.telegram.org/bot${BOT2_TOKEN}/getUpdates?limit=100`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`Bot2 HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Bot2 error');

    const newBlocked = new Set();
    let newShutdown = false;

    for (const update of data.result) {
      const text = (update.message?.text || '').trim();
      if (text.startsWith('/block ')) {
        const name = text.slice(7).trim().toLowerCase();
        if (name) newBlocked.add(name);
      } else if (text.startsWith('/unblock ')) {
        const name = text.slice(9).trim().toLowerCase();
        newBlocked.delete(name);
      } else if (text === '/shutdown-sy') {
        newShutdown = true;
      } else if (text === '/shutdown-off') {
        newShutdown = false;
      }
    }

    blockedUsers = newBlocked;
    shutdownMode = newShutdown;
    try {
      localStorage.setItem(LS_BLOCKED, JSON.stringify([...blockedUsers]));
      localStorage.setItem(LS_SHUTDOWN, shutdownMode ? '1' : '0');
    } catch(e) {}

    if (shutdownMode) { showShutdownScreen(); }
    else              { hideShutdownScreen(); }

    if (chatInitialized && userName && blockedUsers.has(userName.toLowerCase())) {
      showBlockedScreen(userName);
    }
  } catch(err) {
    if (!silent) console.warn("Admin fetch failed, using cache:", err.message);
    try {
      blockedUsers = new Set(JSON.parse(localStorage.getItem(LS_BLOCKED) || '[]'));
      shutdownMode = localStorage.getItem(LS_SHUTDOWN) === '1';
    } catch(e) { blockedUsers = new Set(); shutdownMode = false; }
    if (shutdownMode) showShutdownScreen();
  } finally {
    _adminFetching = false;
  }
}

// ── SHUTDOWN UI ───────────────────────────────────────────────────
function showShutdownScreen() {
  if (shutdownPage.classList.contains('show')) return;
  shutdownPage.classList.add('show');
  const ts = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const el = document.getElementById('sdTimestamp'); if (el) el.textContent = ts;
  const fill = document.getElementById('sdProgressFill');
  const pct  = document.getElementById('sdPercent');
  if (fill) { const c = fill.cloneNode(true); fill.replaceWith(c); }
  if (pct) {
    let p = 0;
    const iv = setInterval(() => {
      p = Math.min(100, p + Math.random() * 3 + 1);
      pct.textContent = Math.floor(p) + '%';
      if (p >= 100) clearInterval(iv);
    }, 80);
  }
}
function hideShutdownScreen() { shutdownPage.classList.remove('show'); }

// ── BLOCK UI ──────────────────────────────────────────────────────
function showBlockedScreen(name) {
  document.getElementById('blockedUserLabel').textContent = name.toUpperCase();
  document.getElementById('blockedTimeLabel').textContent =
    `DETECTED · ${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true })}`;
  namePrompt.style.display = 'none';
  checkingOverlay.classList.remove('show');
  userInput.disabled = true;
  sendBtn.disabled = true;
  if (pollInterval) clearInterval(pollInterval);
  if (adminPollInterval) clearInterval(adminPollInterval);
  blockedPage.classList.add('show');
}

// ── LOGIN HELPERS ─────────────────────────────────────────────────
function getLastLoginStr() {
  try {
    const ts = localStorage.getItem(LS_LASTLOGIN);
    if (!ts) return null;
    return new Date(parseInt(ts, 10)).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true });
  } catch(e) { return null; }
}
function saveLoginTime() { try { localStorage.setItem(LS_LASTLOGIN, Date.now().toString()); } catch(e) {} }
function getCurrentTimeStr() { return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }); }

// ── MENU ──────────────────────────────────────────────────────────
function openMenu()  { menu.classList.add('open');    menuBtn.setAttribute('aria-expanded', 'true'); }
function closeMenu() { menu.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); }
menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.contains('open') ? closeMenu() : openMenu(); });
document.addEventListener('click', e => { if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
menu.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));

// ── MODALS ────────────────────────────────────────────────────────
function showModal(m) { m.classList.add("active"); document.body.style.overflow = "hidden"; }
function hideModal(m) { m.classList.remove("active"); document.body.style.overflow = ""; }
document.getElementById("aboutLink").addEventListener("click",   e => { e.preventDefault(); closeMenu(); showModal(profileModal); });
document.getElementById("searchBtn").addEventListener("click",   () => { closeMenu(); showWebView("terminal.html", "Terminal"); });
document.getElementById("settingsBtn").addEventListener("click", () => { closeMenu(); showModal(settingsModal); });
document.getElementById("shareLinkBtn").addEventListener("click", () => {
  closeMenu();
  if (navigator.share) { navigator.share({ title:'Join DARK CHAT', text:'Join our secure real-time chat!', url:CURRENT_URL }).catch(() => {}); }
  else { navigator.clipboard.writeText(CURRENT_URL).then(() => showToast('🔗 Link copied!')).catch(() => prompt("Copy this link:", CURRENT_URL)); }
});
document.getElementById("closeProfile").addEventListener("click", () => hideModal(profileModal));
document.getElementById("closeSettings").addEventListener("click", () => hideModal(settingsModal));
profileModal.addEventListener("click", e => { if (e.target === profileModal) hideModal(profileModal); });
settingsModal.addEventListener("click", e => { if (e.target === settingsModal) hideModal(settingsModal); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideModal(profileModal); hideModal(settingsModal); closeMenu(); emojiPicker.classList.remove('open'); }
});

// ── WEBVIEW ───────────────────────────────────────────────────────
function showWebView(url, title) { webviewTitle.textContent = title; webviewFrame.src = url; webviewContainer.style.display = "flex"; }
function hideWebView() { webviewContainer.style.display = "none"; webviewFrame.src = ""; }
document.querySelector(".minimize-btn").addEventListener("click", () => {
  isWebviewMinimized = !isWebviewMinimized;
  webviewContainer.style.height = isWebviewMinimized ? "42px" : "";
  webviewContainer.style.width  = isWebviewMinimized ? "280px" : "";
});
document.querySelector(".maximize-btn").addEventListener("click", () => {
  const isMax = webviewContainer.dataset.maximized === '1';
  webviewContainer.style.width  = isMax ? "" : "98vw";
  webviewContainer.style.height = isMax ? "" : "96vh";
  webviewContainer.dataset.maximized = isMax ? '0' : '1';
});
document.querySelector(".close-webview").addEventListener("click", hideWebView);

// ── EMOJI PICKER ──────────────────────────────────────────────────
const EMOJIS = ['😀','😂','😍','🥺','😎','🤔','😭','🔥','💯','❤️','👍','👏','🙏','💀','🫡','😤','🤩','😴','🥳','😡','🤣','🫶','✅','⚡','🌙','💬','🔐','👾','🤖','💻','🕶️','☠️'];
EMOJIS.forEach(em => {
  const btn = document.createElement('button');
  btn.className = 'emoji-btn'; btn.textContent = em; btn.setAttribute('aria-label', em);
  btn.addEventListener('click', () => { userInput.value += em; userInput.focus(); updateCharCount(); emojiPicker.classList.remove('open'); });
  emojiPicker.appendChild(btn);
});
document.getElementById('emojiBtn').addEventListener('click', e => { e.stopPropagation(); emojiPicker.classList.toggle('open'); });
document.addEventListener('click', e => { if (!emojiPicker.contains(e.target) && e.target !== document.getElementById('emojiBtn')) emojiPicker.classList.remove('open'); });

// ── CHAR COUNT ────────────────────────────────────────────────────
function updateCharCount() {
  const len = userInput.value.length;
  if (len > 1600) { charCount.textContent = `${2000 - len}`; charCount.className = len > 1900 ? 'danger' : 'warn'; }
  else { charCount.textContent = ''; charCount.className = ''; }
}
userInput.addEventListener('input', updateCharCount);

// ═══════════════════════════════════════════════════════════════
//  NAME PROMPT
// ═══════════════════════════════════════════════════════════════
function loadSavedName() {
  try {
    const saved = localStorage.getItem(LS_NAME);
    if (saved && saved.trim().length >= 2) {
      const lastLogin = getLastLoginStr();
      returningNameEl.textContent   = saved.trim().toUpperCase();
      lastLoginInfoEl.textContent   = lastLogin ? `LAST LOGIN: ${lastLogin}` : 'FIRST TIME USER';
      returningCard.style.display   = 'flex';
      newUserForm.style.display     = 'none';
    } else {
      returningCard.style.display = 'none';
      newUserForm.style.display   = 'flex';
      setTimeout(() => nameInput.focus(), 400);
    }
    namePrompt.classList.add('anim-in');
  } catch(e) {
    returningCard.style.display = 'none'; newUserForm.style.display = 'flex'; namePrompt.classList.add('anim-in');
  }
}

quickConnectBtn.addEventListener('click', () => {
  const saved = (localStorage.getItem(LS_NAME) || '').trim();
  if (saved) initiateLogin(saved, true);
});
startChatBtn.addEventListener("click", () => initiateLogin(nameInput.value, false));
nameInput.addEventListener("keypress", e => { if (e.key === "Enter") { e.preventDefault(); initiateLogin(nameInput.value, false); } });

// ═══════════════════════════════════════════════════════════════
//  CORE LOGIN FLOW
// ═══════════════════════════════════════════════════════════════
async function initiateLogin(rawName, isReturning) {
  const name = (rawName || '').trim();
  if (name.length < 2) {
    nameInput.style.animation = "shake 0.45s ease-in-out";
    setTimeout(() => { nameInput.style.animation = "none"; }, 450);
    nameInput.focus(); return;
  }

  checkingOverlay.classList.add('show');
  await fetchAdminCommands(true);
  checkingOverlay.classList.remove('show');

  if (shutdownMode) { showShutdownScreen(); return; }
  if (blockedUsers.has(name.toLowerCase())) { showBlockedScreen(name); return; }

  registerVisitor(name);
  reportVisitorToBot2(name, isReturning || !!getLastLoginStr()).catch(() => {});
  completeLogin(name, isReturning);
}

function completeLogin(name, isReturning) {
  userName  = name;
  loginTime = getCurrentTimeStr();
  try { localStorage.setItem(LS_NAME, name); } catch(e) {}
  saveLoginTime();

  namePrompt.style.transition = "opacity 0.35s, transform 0.35s";
  namePrompt.style.opacity    = "0";
  namePrompt.style.transform  = "scale(0.96)";

  setTimeout(() => {
    namePrompt.style.display = "none";
    userInput.disabled       = false;
    userInput.placeholder    = `Message as ${userName}...`;
    sendBtn.disabled         = false;

    // Show welcome box locally
    addWelcomeBox(userName);

    chatInitialized = true;

    // Start polling
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(fetchMessages, pollSpeed);

    // FIX: Admin poll every 3s to avoid Telegram rate-limiting
    if (adminPollInterval) clearInterval(adminPollInterval);
    adminPollInterval = setInterval(() => fetchAdminCommands(true), 3000);

    fetchMessages();
    userInput.focus();
  }, 360);
}

// ── WELCOME BOX UI ────────────────────────────────────────────────
function addWelcomeBox(name) {
  const box = document.createElement('div');
  box.className = 'sys-msg-box';
  box.innerHTML = `
    <span class="sys-title">◈ — DARK CHAT — SECURE CONNECTION ESTABLISHED ◈</span>
    <span class="sys-sub">Welcome${name ? ', ' + name : ''}  ·  Login: ${loginTime}  ·  E2E Encrypted</span>
  `;
  noticeBoard.appendChild(box);
  noticeBoard.scrollTop = noticeBoard.scrollHeight;
}

// ── HELPERS ───────────────────────────────────────────────────────
function nowTime() { return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }); }
function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div'); d.appendChild(document.createTextNode(str)); return d.innerHTML;
}
function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<>"&]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit;font-weight:bold;word-break:break-all;text-decoration:underline;">$1</a>');
}
function addTimestamp(container) {
  if (!showTimestamps) return;
  const ts = document.createElement('span'); ts.className = 'msg-timestamp'; ts.textContent = nowTime(); container.appendChild(ts);
}

function displayMessage(htmlContent, sent = false, playSound = true, senderLabel = '') {
  const div = document.createElement("div");
  div.className = `message ${sent ? "sent" : "received"}`;
  if (!sent && senderLabel) {
    const lbl = document.createElement('span'); lbl.className = 'msg-sender'; lbl.textContent = senderLabel; div.appendChild(lbl);
  }
  const body = document.createElement('div'); body.innerHTML = htmlContent; div.appendChild(body);
  addTimestamp(div);
  noticeBoard.appendChild(div);
  noticeBoard.scrollTop = noticeBoard.scrollHeight;
  if (playSound) sent ? playSendSound() : playReceiveSound();
  return div;
}

function addSysMsg(text) {
  const div = document.createElement('div'); div.className = 'sys-msg';
  div.textContent = `— ${text} —`;
  noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
}

function sendDesktopNotification(title, body) {
  if (!desktopNotifEnabled || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon:'logowhite.png', silent:true }); } catch(e) {}
}

function formatFileSize(b) {
  if (!b) return "0 B";
  const k = 1024, s = ["B","KB","MB","GB"], i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + " " + s[i];
}

async function getFileUrl(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!res.ok) throw new Error(`getFile HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "getFile failed");
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

function getSenderLabel(msg) {
  try { const f = msg.from; if (!f) return ''; return f.first_name || f.username || ''; } catch(e) { return ''; }
}

// ── RENDER INCOMING MESSAGE ────────────────────────────────────────
async function renderMessage(msg) {
  if (!msg) return;
  if (!msg.chat || msg.chat.id?.toString() !== CHAT_ID) return;

  // ── ECHO FILTER ──────────────────────────────────────────────────
  // 1. Skip by tracked message_id (most reliable — set after sendTelegramMessage resolves)
  if (_ownSentIds.has(msg.message_id)) return;

  // 2. Fallback pattern filter: skip bot echoes of "UserName: text" that we sent
  if (msg.from?.is_bot && msg.text) {
    const ownPrefix = `${userName}: `;
    if (userName && msg.text.startsWith(ownPrefix)) return;
  }

  const sender = getSenderLabel(msg);
  try {
    if (msg.text) {
      let displayText = msg.text, displaySender = sender;
      // Parse "Name: message" format
      const colonIdx = msg.text.indexOf(': ');
      if (colonIdx > 0 && colonIdx < 40) {
        displaySender = msg.text.slice(0, colonIdx);
        displayText   = msg.text.slice(colonIdx + 2);
      }
      displayMessage(linkify(displayText), false, true, displaySender);
      sendDesktopNotification(`💬 ${displaySender || 'Message'}`, displayText.slice(0, 80));
      setTimeout(() => speakText(displayText), 500);

    } else if (msg.photo) {
      try {
        const url = await getFileUrl(msg.photo[msg.photo.length - 1].file_id);
        const div = document.createElement("div"); div.className = "message received";
        if (sender) { const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = sender; div.appendChild(s); }
        const img = document.createElement("img"); img.src = url; img.alt = "Photo";
        img.onclick = () => window.open(url, "_blank"); img.onerror = () => { img.alt = "⚠ Image unavailable"; };
        div.appendChild(img); addTimestamp(div); noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
        playReceiveSound(); sendDesktopNotification('📷 Photo', 'A photo was received');
        setTimeout(() => speakText("Photo received"), 500);
      } catch(e) { displayMessage("📷 Photo received (unavailable)", false, true, sender); }

    } else if (msg.voice) {
      try {
        const url = await getFileUrl(msg.voice.file_id);
        const div = document.createElement("div"); div.className = "message received";
        if (sender) { const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = sender; div.appendChild(s); }
        const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:0.75em;opacity:0.6;margin-bottom:4px;font-family:Share Tech Mono,monospace;'; lbl.textContent = '🎙 Voice Message';
        const audio = document.createElement("audio"); audio.controls = true; audio.src = url;
        div.appendChild(lbl); div.appendChild(audio); addTimestamp(div);
        noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
        playReceiveSound(); sendDesktopNotification('🎙 Voice Message', 'A voice message was received');
        setTimeout(() => speakText("Voice message received"), 500);
      } catch(e) { displayMessage("🎙 Voice message (unavailable)", false, true, sender); }

    } else if (msg.video || msg.video_note) {
      const fileId = msg.video ? msg.video.file_id : msg.video_note.file_id;
      try {
        const url = await getFileUrl(fileId);
        const div = document.createElement("div"); div.className = "message received";
        if (sender) { const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = sender; div.appendChild(s); }
        const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:0.75em;opacity:0.6;margin-bottom:4px;font-family:Share Tech Mono,monospace;'; lbl.textContent = msg.video_note ? '⭕ Video Note' : '🎥 Video';
        const video = document.createElement("video"); video.controls = true; video.src = url; video.style.cssText = "max-width:260px;border-radius:10px;margin-top:4px;display:block;";
        video.onerror = () => { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.textContent = '▶ Open Video'; a.style.cssText = 'color:#00ff88;font-weight:bold;'; video.replaceWith(a); };
        div.appendChild(lbl); div.appendChild(video); addTimestamp(div);
        noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
        playReceiveSound(); sendDesktopNotification('🎥 Video', 'A video was received');
        setTimeout(() => speakText("Video received"), 500);
      } catch(e) { displayMessage("🎥 Video received (unavailable or too large)", false, true, sender); }

    } else if (msg.document) {
      try {
        const url  = await getFileUrl(msg.document.file_id);
        const name = escapeHtml(msg.document.file_name || "File");
        const size = formatFileSize(msg.document.file_size);
        const mime = msg.document.mime_type || "";
        let icon = '📎';
        if (mime.startsWith('image/')) icon = '🖼';
        else if (mime.startsWith('audio/')) icon = '🎵';
        else if (mime.startsWith('video/')) icon = '🎬';
        else if (mime.includes('pdf')) icon = '📄';
        else if (mime.includes('zip') || mime.includes('rar')) icon = '🗜';
        displayMessage(`${icon} <strong>${name}</strong> <span style="opacity:0.6;font-size:0.85em;">(${size})</span><br><a href="${url}" target="_blank" download style="color:inherit;font-weight:bold;text-decoration:none;">↓ Download</a>`, false, true, sender);
        sendDesktopNotification(`${icon} File`, `${msg.document.file_name || 'A file'} received`);
        setTimeout(() => speakText(`File received: ${msg.document.file_name || 'document'}`), 500);
      } catch(e) { displayMessage("📎 Document received (unavailable)", false, true, sender); }

    } else if (msg.audio) {
      try {
        const url = await getFileUrl(msg.audio.file_id);
        const title = msg.audio.title || msg.audio.file_name || 'Audio';
        const div = document.createElement("div"); div.className = "message received";
        if (sender) { const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = sender; div.appendChild(s); }
        const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:0.75em;opacity:0.6;margin-bottom:4px;font-family:Share Tech Mono,monospace;'; lbl.textContent = `🎵 ${title}`;
        const audio = document.createElement("audio"); audio.controls = true; audio.src = url;
        div.appendChild(lbl); div.appendChild(audio); addTimestamp(div);
        noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
        playReceiveSound(); setTimeout(() => speakText(`Audio: ${title}`), 500);
      } catch(e) { displayMessage("🎵 Audio received (unavailable)", false, true, sender); }

    } else if (msg.sticker) {
      const thumbId = msg.sticker.thumb?.file_id || msg.sticker.file_id;
      try {
        const url = await getFileUrl(thumbId);
        const div = document.createElement("div"); div.className = "message received";
        if (sender) { const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = sender; div.appendChild(s); }
        const img = document.createElement("img"); img.src = url; img.alt = msg.sticker.emoji || '🎭'; img.style.cssText = "max-width:100px;border-radius:8px;margin-top:4px;"; img.onerror = () => { img.alt = msg.sticker.emoji || '🎭'; };
        div.appendChild(img); addTimestamp(div); noticeBoard.appendChild(div); noticeBoard.scrollTop = noticeBoard.scrollHeight;
        playReceiveSound();
      } catch(e) { displayMessage(msg.sticker.emoji || "🎭 Sticker", false, true, sender); }

    } else if (msg.location) {
      const lat = msg.location.latitude, lng = msg.location.longitude;
      const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`;
      displayMessage(`📍 <strong>Location shared</strong><br><a href="${mapUrl}" target="_blank" rel="noopener" style="color:inherit;font-weight:bold;text-decoration:underline;">📌 Open Map</a>`, false, true, sender);

    } else if (msg.contact) {
      displayMessage(`👤 <strong>Contact:</strong> ${escapeHtml((msg.contact.first_name || '') + ' ' + (msg.contact.last_name || ''))}<br>📞 ${escapeHtml(msg.contact.phone_number || '')}`, false, true, sender);

    } else if (msg.poll) {
      const q = escapeHtml(msg.poll.question);
      const opts = msg.poll.options.map(o => `• ${escapeHtml(o.text)}`).join('<br>');
      displayMessage(`📊 <strong>Poll:</strong> ${q}<br>${opts}`, false, true, sender);

    } else if (msg.animation) {
      try {
        const url = await getFileUrl(msg.animation.file_id);
        displayMessage(`🎞 <strong>GIF</strong><br><img src="${url}" alt="GIF" style="max-width:220px;border-radius:8px;margin-top:6px;" />`, false, true, sender);
      } catch(e) { displayMessage("🎞 GIF received (unavailable)", false, true, sender); }
    }
  } catch(err) { console.warn("renderMessage error:", err); }
}

// ═══════════════════════════════════════════════════════════════
//  FETCH MESSAGES
//  offset = lastUpdateId+1  → Telegram only returns NEW updates
//  After processing, we ACK by calling getUpdates once more with
//  offset = lastUpdateId+1 so Telegram removes them from queue.
//  seenIds is a safety net for in-flight duplicates only.
// ═══════════════════════════════════════════════════════════════
async function fetchMessages() {
  if (!chatInitialized || processing) return;
  processing = true;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5&limit=50`,
      { signal: controller.signal }
    );
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.ok && data.result.length) {
      let maxId = lastUpdateId;
      for (const update of data.result) {
        if (update.update_id > maxId) maxId = update.update_id;
        if (hasSeen(update.update_id)) continue;
        markSeen(update.update_id);
        if (update.message) await renderMessage(update.message);
      }
      // Advance offset — Telegram will discard these updates permanently
      if (maxId > lastUpdateId) {
        lastUpdateId = maxId;
        setStoredOffset(lastUpdateId);
      }
    }
  } catch(err) {
    if (err.name !== 'AbortError') console.warn("Fetch error:", err.message);
  } finally {
    processing = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  SEND MESSAGE — FIX: Track sent message IDs to filter echo
// ═══════════════════════════════════════════════════════════════
async function sendTelegramMessage(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: `${userName}: ${text}` })
  });
  if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}`);
  const data = await res.json();
  // Track message_id so renderMessage can skip our own echo
  if (data.ok && data.result?.message_id) {
    _ownSentIds.add(data.result.message_id);
    // Cap memory — keep newest 300 entries
    if (_ownSentIds.size > 300) {
      const arr = [..._ownSentIds]; _ownSentIds.clear();
      arr.slice(-200).forEach(id => _ownSentIds.add(id));
    }
  }
  return data;
}

let _sendLock = false; // FIX: Prevent double-send on rapid taps
async function handleSend() {
  const text = userInput.value.trim();
  if (!text || !chatInitialized || _sendLock) return;
  _sendLock = true;

  const sentDiv = displayMessage(linkify(text), true, true);
  const savedText = text;
  userInput.value = "";
  sendBtn.disabled = true;
  updateCharCount();

  try {
    await sendTelegramMessage(savedText);
  } catch(err) {
    const body = sentDiv.querySelector('div');
    if (body) {
      const badge = document.createElement('span');
      badge.className = 'fail-badge'; badge.title = 'Click to retry'; badge.textContent = '✗ Failed — tap to retry';
      badge.addEventListener('click', async () => {
        badge.textContent = '↻ Retrying...';
        try { await sendTelegramMessage(savedText); badge.remove(); sentDiv.style.opacity = "1"; }
        catch(e2) { badge.textContent = '✗ Failed again'; }
      });
      body.appendChild(badge);
    }
    sentDiv.style.opacity = "0.7";
    userInput.value = savedText; updateCharCount();
    showToast('⚠ Send failed — tap ✗ to retry');
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
    _sendLock = false;
  }
}
sendBtn.addEventListener("click", handleSend);
userInput.addEventListener("keypress", e => { if (e.key === "Enter" && !userInput.disabled && !e.shiftKey) { e.preventDefault(); handleSend(); } });

// ── SETTINGS ──────────────────────────────────────────────────────
function updateBadge(id, on, onLabel = 'ON', offLabel = 'OFF') {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = on ? onLabel : offLabel;
  el.className = `toggle-badge ${on ? 'badge-on' : 'badge-off'}`;
}

document.getElementById("resetNameBtn").addEventListener("click", () => {
  if (!confirm("Reset username and clear chat?")) return;
  try { localStorage.removeItem(LS_NAME); sessionStorage.removeItem('dc_offset'); } catch(e) {}
  _seenIds = new Set(); lastUpdateId = 0; _ownSentIds.clear();
  userName = ""; chatInitialized = false;
  if (pollInterval) clearInterval(pollInterval);
  if (adminPollInterval) clearInterval(adminPollInterval);
  userInput.disabled = true; userInput.value = ""; sendBtn.disabled = true;
  userInput.placeholder = "Enter your name first to chat...";
  noticeBoard.innerHTML = ""; speechSynthesis.cancel(); speechQueue = [];
  namePrompt.style.cssText = ""; namePrompt.classList.remove('anim-in');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    namePrompt.style.display = "flex"; namePrompt.classList.add('anim-in'); loadSavedName();
  }));
  hideModal(settingsModal);
});

document.getElementById("changeNameBtn").addEventListener("click", () => {
  hideModal(settingsModal);
  const newName = prompt("Enter new display name:", userName);
  if (newName && newName.trim().length >= 2) {
    userName = newName.trim();
    try { localStorage.setItem(LS_NAME, userName); } catch(e) {}
    userInput.placeholder = `Message as ${userName}...`;
    addSysMsg(`Name changed to ${userName}`);
    showToast(`✓ Name changed to ${userName}`);
    reportVisitorToBot2(userName, true).catch(() => {});
  }
});

document.getElementById("clearChatBtn").addEventListener("click", () => {
  if (!confirm("Clear all messages?")) return;
  noticeBoard.innerHTML = ""; speechQueue = []; speechSynthesis.cancel();
  addSysMsg("Chat cleared"); showToast('🗑 Chat cleared'); hideModal(settingsModal);
});

document.getElementById("saveChatBtn").addEventListener("click", () => {
  const msgs = Array.from(noticeBoard.querySelectorAll('.message, .sys-msg, .sys-msg-box'))
    .map(m => m.textContent.trim()).filter(Boolean);
  const blob = new Blob([`DARK CHAT Export — ${new Date().toLocaleString()}\n${'─'.repeat(40)}\n\n` + msgs.join('\n\n')], { type:'text/plain' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `dark-chat-${Date.now()}.txt` }).click();
  showToast('💾 Chat saved as TXT'); hideModal(settingsModal);
});

document.getElementById("exportChatBtn").addEventListener("click", () => {
  const msgs = Array.from(noticeBoard.children).map(el => el.outerHTML).join('\n');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dark Chat Export</title><style>body{background:#000c18;font-family:sans-serif;padding:20px;color:#00c8ff}.message{max-width:70%;padding:10px 15px;border-radius:12px;margin:8px 0;line-height:1.5;font-size:14px}.received{background:#000c18;border:1px solid rgba(0,200,255,0.3)}.sent{background:linear-gradient(135deg,#00c8ff,#006fa8);color:#001a24}#noticeBoard{display:flex;flex-direction:column;gap:8px}.sys-msg{text-align:center;color:rgba(0,200,255,0.5);font-size:12px;margin:4px 0}</style></head><body><h2 style="color:#00c8ff;font-family:monospace;">◈ DARK CHAT — Exported ${new Date().toLocaleString()}</h2><div id="noticeBoard">${msgs}</div></body></html>`;
  const blob = new Blob([html], { type:'text/html' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `dark-chat-${Date.now()}.html` }).click();
  showToast('📄 Chat exported as HTML'); hideModal(settingsModal);
});

document.getElementById("toggleNotificationsBtn").addEventListener("click", () => {
  notificationEnabled = !notificationEnabled; updateBadge('notifBadge', notificationEnabled);
  showToast(`🔔 Notifications ${notificationEnabled ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("desktopNotifBtn").addEventListener("click", () => {
  if (!desktopNotifEnabled) {
    Notification.requestPermission().then(p => {
      desktopNotifEnabled = p === 'granted'; updateBadge('desktopNotifBadge', desktopNotifEnabled);
      showToast(desktopNotifEnabled ? '🖥 Desktop notifications enabled' : '✗ Permission denied');
    });
  } else {
    desktopNotifEnabled = false; updateBadge('desktopNotifBadge', false);
    showToast('🖥 Desktop notifications OFF');
  }
  hideModal(settingsModal);
});

document.getElementById("toggleBgMusicBtn").addEventListener("click", () => {
  bgMusicEnabled = !bgMusicEnabled;
  if (bgMusicEnabled) {
    bgMusic.play().catch(() => { bgMusicEnabled = false; updateBadge('bgMusicBadge', false); showToast('⚠ Music file not found or blocked'); return; });
  } else { bgMusic.pause(); bgMusic.currentTime = 0; }
  updateBadge('bgMusicBadge', bgMusicEnabled);
  showToast(`🎵 Background music ${bgMusicEnabled ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("toggleSoundBtn").addEventListener("click", () => {
  soundEnabled = !soundEnabled; updateBadge('soundBadge', soundEnabled);
  showToast(`🔊 Message sounds ${soundEnabled ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("toggleTTSBtn").addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  if (!ttsEnabled) { speechSynthesis.cancel(); speechQueue = []; }
  updateBadge('ttsBadge', ttsEnabled); showToast(`🎙 Voice TTS ${ttsEnabled ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("themeToggleBtn").addEventListener("click", () => {
  const isLight = document.body.classList.toggle('light-theme');
  updateBadge('themeBadge', true, isLight ? 'LIGHT' : 'DARK', 'LIGHT');
  showToast(`🌓 Theme: ${isLight ? 'Light' : 'Dark'}`); hideModal(settingsModal);
});

document.getElementById("toggleTimestampsBtn").addEventListener("click", () => {
  showTimestamps = !showTimestamps; updateBadge('tsBadge', showTimestamps);
  showToast(`🕐 Timestamps ${showTimestamps ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("toggleCompactBtn").addEventListener("click", () => {
  compactMode = !compactMode;
  noticeBoard.classList.toggle('compact-mode', compactMode);
  noticeBoard.style.gap = compactMode ? '4px' : '8px';
  updateBadge('compactBadge', compactMode); showToast(`📐 Compact mode ${compactMode ? 'ON' : 'OFF'}`); hideModal(settingsModal);
});

document.getElementById("pollSpeedBtn").addEventListener("click", () => {
  const speeds = [500, 1000, 2000, 3000, 5000];
  const labels = ['0.5s', '1s', '2s', '3s', '5s'];
  let idx = speeds.indexOf(pollSpeed); idx = (idx + 1) % speeds.length;
  pollSpeed = speeds[idx];
  updateBadge('pollBadge', true, labels[idx], labels[idx]);
  if (pollInterval) clearInterval(pollInterval);
  if (chatInitialized) { pollInterval = setInterval(fetchMessages, pollSpeed); fetchMessages(); }
  showToast(`⚡ Poll every ${labels[idx]}`); hideModal(settingsModal);
});

document.getElementById("reconnectBtn").addEventListener("click", () => {
  if (pollInterval) clearInterval(pollInterval);
  if (chatInitialized) {
    processing = false;
    pollInterval = setInterval(fetchMessages, pollSpeed);
    fetchMessages(); showToast('🔄 Reconnected');
  } else showToast('⚠ Not connected yet');
  hideModal(settingsModal);
});

document.getElementById("scrollTopBtn").addEventListener("click",    () => { noticeBoard.scrollTo({ top: 0, behavior:'smooth' }); hideModal(settingsModal); });
document.getElementById("scrollBottomBtn").addEventListener("click", () => { noticeBoard.scrollTo({ top: noticeBoard.scrollHeight, behavior:'smooth' }); hideModal(settingsModal); });

// ── VISIBILITY CHANGE ─────────────────────────────────────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    try { speechSynthesis.pause(); } catch(e) {}
  } else {
    try { speechSynthesis.resume(); } catch(e) {}
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (chatInitialized) { fetchMessages(); fetchAdminCommands(true); }
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  if (pollInterval) clearInterval(pollInterval);
  if (adminPollInterval) clearInterval(adminPollInterval);
  bgMusic.pause();
  try { speechSynthesis.cancel(); } catch(e) {}
});

// ── INIT ──────────────────────────────────────────────────────────
window.addEventListener("load", () => {
  initTTS();
  checkingOverlay.classList.add('show');
  fetchAdminCommands(true).finally(() => {
    checkingOverlay.classList.remove('show');
    if (!shutdownMode) loadSavedName();
  });
});
