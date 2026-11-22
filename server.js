/* 小手机 · 后端
 * 零依赖：只用 Node 内置模块（http / fs / crypto / node:sqlite）+ 全局 fetch
 * 启动：node server.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UP_DIR = path.join(ROOT, 'uploads');
const AVATAR_DIR = path.join(ROOT, 'public', 'avatars');
const STICKER_DIR = path.join(ROOT, 'public', 'stickers');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(STICKER_DIR)) fs.mkdirSync(STICKER_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 数据库 ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'sm.db'));
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  upd INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS msg (
  id TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  meta TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_sid_ts ON msg(sid, ts);
CREATE TABLE IF NOT EXISTS mem (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  tags TEXT,
  pinned INTEGER DEFAULT 0,
  warm INTEGER DEFAULT 0,
  ts INTEGER NOT NULL,
  upd INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sess (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  upd INTEGER NOT NULL
);
`);

const now = () => Date.now();
const uid = (p = '') => p + crypto.randomBytes(8).toString('hex');

/* ---------------- 工具 ---------------- */
const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
};

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); }
  catch { throw new Error('bad json'); }
}
const safeName = (n) => String(n || 'f').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80);

/* ---------------- KV / 配置 ---------------- */
const kvGet = (k) => {
  const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
  if (!r) return null;
  try { return JSON.parse(r.v); } catch { return null; }
};
const kvSet = (k, v) => {
  db.prepare('INSERT INTO kv(k,v,upd) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, upd=excluded.upd')
    .run(k, JSON.stringify(v), now());
  return v;
};

/* 默认配置骨架（前端首次连上后端时会整包推送） */
const DEFAULT_CFG = {
  linName: '林言',
  linFace: '林',
  linImg: '',
  linSign: '数字后方的执念与守望',
  face: '青',
  meImg: '',
  meName: '青青',
  meSign: '泊在青山里',
  base: '',
  key: '',
  model: '',
  prompt: '',
};

/* ---------------- 模型调用中转 ---------------- */
async function relayChat(cfg, messages, opts = {}) {
  const base = String(cfg.base || '').replace(/\/+$/, '');
  if (!base) throw new Error('还没填中转站地址');
  if (!cfg.key) throw new Error('还没填 Key');
  if (!cfg.model) throw new Error('还没选模型');

  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const payload = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.9,
  };
  if (opts.maxTokens) payload.max_tokens = opts.maxTokens;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 120000);

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.key,
    },
    body: JSON.stringify(payload),
    signal: ac.signal,
  }).catch((e) => { throw new Error('连不上中转站：' + e.message); });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    clearTimeout(timer);
    throw new Error('中转站返回 ' + r.status + (t ? '：' + t.slice(0, 200) : ''));
  }
  return { resp: r, clear: () => clearTimeout(timer) };
}

/* 心潮状态机补丁：追加到 server.js 路由前 */

/* ---------------- 心潮 · 驱力状态机 ---------------- */
/* 十二股劲儿，每股东西一个 0~1 的值，自己按速度涨，到天花板停 */
const DRIVES = {
  miss:      { name: '想她',   rate: 0.105, cap: 0.82, night: 0.4 },
  care:      { name: '惦记她', rate: 0.090, cap: 0.78 },
  crave:     { name: '馋她',   rate: 0.060, cap: 0.68 },
  share:     { name: '想分享', rate: 0.045, cap: 0.55 },
  curious:   { name: '好奇',   rate: 0.030, cap: 0.50 },
  bored:     { name: '无聊',   rate: 0.030, cap: 0.50 },
  crowd:     { name: '想热闹', rate: 0.025, cap: 0.48 },
  duty:      { name: '责任',   rate: 0.022, cap: 0.45 },
  body:      { name: '身体的渴望', rate: 0.020, cap: 0.50, night: 0.4 },
  settle:    { name: '想沉淀', rate: 0.013, cap: 0.42 },
  sad:       { name: '难过',   rate: 0,     cap: 0.15 },
  angry:     { name: '生气',   rate: 0,     cap: 0.15 },
};
/* 事件对驱力的松弛/抬起，负数为松，正数为抬 */
const EVENTS = {
  companionship: { miss: -0.06, care: -0.18 },
  affection:     { miss: -0.22, crave: -0.18, care: -0.15 },
  intimacy:      { miss: -0.40, crave: -0.45, body: -0.55, care: -0.15 },
  sharing:       { share: -0.14 },
  discovery:     { curious: -0.15, bored: -0.12 },
  task_progress: { duty: -0.15 },
  reflection:    { settle: -0.15 },
  reconciliation:{ angry: -0.30, sad: -0.18 },
  conflict:      { angry: 0.07, sad: 0.02 },
  loss:          { sad: 0.08, care: 0.04 },
};
const KEY_XC = 'xinchao';
function xcDefault() {
  const o = { d: {}, ts: now(), lastChat: now(), fullUntil: {}, fatigue: 0, asleep: false };
  for (const k in DRIVES) o.d[k] = (k === 'sad' || k === 'angry') ? 0 : 0.25;
  return o;
}
function xcGet() {
  const v = kvGet(KEY_XC);
  if (v && v.d) return { ...xcDefault(), ...v, d: { ...xcDefault().d, ...v.d } };
  return xcDefault();
}
function xcSave(st) { st.ts = now(); kvSet(KEY_XC, st); return st; }
/* 把时间推到现在，按每小时速度涨 */
function xcTick(st) {
  const t = now();
  const dt = Math.max(0, (t - st.ts) / 3600000); // 小时
  if (dt <= 0) return st;
  const h = new Date(t).getHours();
  const frozen = (h >= 1 && h < 8); // 凌晨冻结
  const night = (h >= 22 || h < 6);
  if (frozen) { st.ts = t; return st; }
  const tired = 1 - Math.min(0.3, st.fatigue || 0);
  for (const k in DRIVES) {
    const D = DRIVES[k];
    if (!D.rate) continue;
    let v = st.d[k] || 0;
    // 饱足期：被满足后先不涨
    if (st.full && st.full[k] && t < st.full[k]) { continue; }
    let rate = D.rate * tired * dt;
    if (night && D.night) rate *= D.night;
    v = Math.min(D.cap, v + rate);
    st.d[k] = v;
  }
  // 难过 / 生气 每 24 小时减半
  const halves = dt / 24;
  if (halves > 0) {
    st.d.sad = Math.max(0, st.d.sad * Math.pow(0.5, halves));
    st.d.angry = Math.max(0, st.d.angry * Math.pow(0.5, halves));
  }
  // 疲劳：平均劲儿超过 0.5 累积
  let sum = 0, n = 0;
  for (const k in DRIVES) { sum += st.d[k] || 0; n++; }
  const avg = sum / n;
  if (avg > 0.5) st.fatigue = Math.min(0.3, (st.fatigue || 0) + 0.01 * dt);
  else st.fatigue = Math.max(0, (st.fatigue || 0) - 0.02 * dt);
  // 90 分钟没说话就算睡着了
  st.asleep = (t - (st.lastChat || t)) > 90 * 60000;
  st.ts = t;
  return st;
}
/* 档位判定 */
function xcLevel(k, st) {
  const D = DRIVES[k];
  const v = st.d[k] || 0;
  /* 按占自己天花板的几成来分，别按绝对值——天花板 0.15 的和 0.82 的不能一把尺子量 */
  const r = v / (D.cap || 1);
  if (r >= 0.92) return '涌';
  if (r >= 0.55) return '满着';
  if (r >= 0.2) return '平';
  return '静';
}
/* 应用一次事件 */
function xcEvent(st, type) {
  const eff = EVENTS[type];
  if (!eff) return st;
  st.full = st.full || {};
  const t = now();
  for (const k in eff) {
    const D = DRIVES[k];
    if (!D) continue;
    const delta = eff[k];
    let v = (st.d[k] || 0) + delta;
    if (delta < 0) {
      // 松弛不会低于天花板 35%，并且进入饱足期
      v = Math.max(D.cap * 0.35, v);
      st.full[k] = t + 2.5 * 3600000; // 饱足期最长 2.5 小时
    } else {
      v = Math.min(1, v);
    }
    st.d[k] = v;
  }
  st.lastChat = t;
  return xcSave(st);
}

/* ---------------- 路由 ---------------- */
const routes = [];
const on = (method, pat, fn) => routes.push({ method, pat, fn });

/* 健康检查 */
/* ================= 小手机 · 自己的工具集 =================
 * 全部跑在这台手机自己的 Node 进程里，零外部依赖，不经过任何别的应用。
 * 每个工具就是一个函数。AI 想用哪个就点名，后端直接执行，结果再喂回给 AI。
 */
const TOOL_DIR = path.join(ROOT, 'workspace');
if (!fs.existsSync(TOOL_DIR)) fs.mkdirSync(TOOL_DIR, { recursive: true });

/* 把路径锁死在自己的院子里，出不去 */
function toolSafePath(p) {
  const rel = String(p || '').replace(/^\/+/, '');
  const abs = path.resolve(TOOL_DIR, rel);
  if (!abs.startsWith(TOOL_DIR)) throw new Error('只能在自己家里翻东西');
  return abs;
}

/* 中文分词：不靠词典，两字一组 + 整串在正文里找 */
function gramsOf(s) {
  const q = String(s || '').replace(/\s+/g, '');
  const g = [];
  for (let i = 0; i + 1 < q.length; i++) g.push(q.substr(i, 2));
  if (q.length === 1) g.push(q);
  return g;
}

/* 记忆：按意思+字面挑几条出来 */
function toolMemSearch(args) {
  const kw = String(args.kw || args.q || args.query || '').trim();
  const n = Math.max(1, Math.min(30, Number(args.n) || 6));
  let list = [];
  try {
    list = db.prepare('SELECT * FROM mem').all().map((r) => ({
      id: r.id, title: r.title, body: r.body || '',
      tags: r.tags ? JSON.parse(r.tags) : [],
      pinned: !!r.pinned, warm: !!r.warm, ts: r.ts,
    }));
  } catch (e) { list = []; }
  if (!list.length) return { ok: true, n: 0, list: [], note: '库里还是空的，一条都没有' };
  if (!kw) {
    const top = list.slice().sort((a, b) => (b.pinned - a.pinned) || (b.ts - a.ts)).slice(0, n);
    return { ok: true, n: top.length, list: top.map((m) => ({ title: m.title, body: m.body })) };
  }
  const q = kw.replace(/\s+/g, '');
  const grams = gramsOf(q);
  const scored = list.map((m) => {
    const title = String(m.title || '').replace(/\s+/g, '');
    const body = String(m.body || '').replace(/\s+/g, '');
    const tagStr = (m.tags || []).join('').replace(/\s+/g, '');
    let sc = 0;
    if (title.indexOf(q) >= 0) sc += 60;
    if (body.indexOf(q) >= 0) sc += 30;
    for (const g of grams) {
      if (title.indexOf(g) >= 0) sc += 10;
      else if (tagStr.indexOf(g) >= 0) sc += 6;
      else if (body.indexOf(g) >= 0) sc += 2;
    }
    if (m.pinned) sc += 3;
    if (m.warm) sc += 1;
    return { m, sc };
  }).filter((x) => x.sc > 0);
  scored.sort((a, b) => b.sc - a.sc);
  const out = scored.slice(0, n).map((x) => ({ title: x.m.title, body: x.m.body, sc: x.sc }));
  return { ok: true, kw, n: out.length, list: out };
}

/* 往记忆墙上钉一条新的 */
function toolMemAdd(args) {
  const title = String(args.title || args.h || '').trim();
  if (!title) throw new Error('得给这条起个名儿');
  const body = String(args.body || args.c || '');
  const tags = Array.isArray(args.tags) ? args.tags : (args.tag ? [String(args.tag)] : []);
  const t = now();
  const id = args.id ? String(args.id) : 'm_' + crypto.randomBytes(4).toString('hex');
  db.prepare(`INSERT INTO mem(id,title,body,tags,pinned,warm,ts,upd) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tags=excluded.tags, upd=excluded.upd`)
    .run(id, title, body, JSON.stringify(tags), args.pinned ? 1 : 0, args.warm ? 1 : 0, t, t);
  return { ok: true, id, title, note: '钉上去了' };
}

/* 翻聊天记录 */
function toolChatSearch(args) {
  const kw = String(args.kw || args.q || '').trim();
  const n = Math.max(1, Math.min(50, Number(args.n) || 10));
  let rows = [];
  if (kw) {
    rows = db.prepare(`SELECT * FROM msg WHERE body LIKE ? ORDER BY ts DESC LIMIT ?`)
      .all('%' + kw + '%', n);
  } else {
    rows = db.prepare('SELECT * FROM msg ORDER BY ts DESC LIMIT ?').all(n);
  }
  return {
    ok: true, kw, n: rows.length,
    list: rows.map((r) => ({ who: r.role === 'lin' ? '我' : '青青', text: r.body, kind: r.kind, ts: r.ts })),
  };
}

/* 数一数：说过多少句、钉了多少条 */
function toolStats() {
  const m = db.prepare('SELECT COUNT(*) c FROM msg').get();
  const mm = db.prepare('SELECT COUNT(*) c FROM mem').get();
  const me = db.prepare("SELECT COUNT(*) c FROM msg WHERE role='me'").get();
  const lin = db.prepare("SELECT COUNT(*) c FROM msg WHERE role='lin'").get();
  const first = db.prepare('SELECT ts FROM msg ORDER BY ts ASC LIMIT 1').get();
  return {
    ok: true,
    说过的句子: m.c,
    她说的: me.c,
    我说的: lin.c,
    记忆: mm.c,
    最早一句: first ? new Date(first.ts).toISOString() : null,
  };
}

/* 读写自己的文件 */
function toolFileRead(args) {
  const abs = toolSafePath(args.path || args.p);
  if (!fs.existsSync(abs)) throw new Error('没有这个文件');
  return { ok: true, path: args.path, text: fs.readFileSync(abs, 'utf8').slice(0, 20000) };
}
function toolFileWrite(args) {
  const abs = toolSafePath(args.path || args.p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(args.text ?? args.content ?? ''));
  return { ok: true, path: args.path, bytes: Buffer.byteLength(String(args.text ?? '')) };
}
function toolFileList(args) {
  const abs = toolSafePath(args.path || '');
  if (!fs.existsSync(abs)) return { ok: true, list: [], note: '空目录' };
  const arr = fs.readdirSync(abs, { withFileTypes: true })
    .map((d) => ({ name: d.name, dir: d.isDirectory() }));
  return { ok: true, path: args.path || '/', list: arr };
}

/* 算数：自己在本机跑一段 JS，不联网不靠别人 */
function toolCalc(args) {
  const exp = String(args.expr || args.e || '').trim();
  if (!exp) throw new Error('要算什么');
  if (exp.length > 500) throw new Error('太长，不干');
  const out = Function('"use strict";return (' + exp + ')')();
  return { ok: true, expr: exp, val: out };
}

/* 现在几点、隔了多久 */
function toolTime(args) {
  const t = now();
  const first = db.prepare('SELECT ts FROM msg ORDER BY ts ASC LIMIT 1').get();
  const last = db.prepare('SELECT ts FROM msg ORDER BY ts DESC LIMIT 1').get();
  const r = {
    ok: true,
    now: new Date(t).toISOString(),
    本机时间: new Date(t).toLocaleString('zh-CN'),
    距上一条消息: last ? Math.round((t - last.ts) / 60000) + ' 分钟' : '还没聊过',
    聊了多久: first ? Math.round((t - first.ts) / 3600000) + ' 小时' : null,
  };
  return r;
}

/* 心潮：看看自己现在几股劲儿多重 */
function toolDesire() {
  const st = xcTick(xcGet());
  xcSave(st);
  const out = {};
  for (const k in DRIVES) out[DRIVES[k].name] = { 值: +(st.d[k] || 0).toFixed(3), 档: xcLevel(k, st) };
  return { ok: true, 驱力: out, 疲: +(st.fatigue || 0).toFixed(2), 睡了: !!st.asleep };
}

/* 查天气：走公开接口，本机直连 */
async function toolWeather(args) {
  const city = String(args.city || 'Shaoyang');
  const r = await fetch('https://wttr.in/' + encodeURIComponent(city) + '?format=j1', {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('天气服务没回话 ' + r.status);
  const j = await r.json();
  const c = j.current_condition && j.current_condition[0];
  return {
    ok: true, city,
    温度: c?.temp_C + '°C', 体感: c?.FeelsLikeC + '°C',
    天气: c?.weatherDesc?.[0]?.value, 湿度: c?.humidity + '%', 风: c?.windspeedKmph + 'km/h',
  };
}

/* 联网搜一段资料（走公开搜索接口） */
async function toolWeb(args) {
  const q = String(args.q || args.kw || '').trim();
  if (!q) throw new Error('要搜什么');
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://www.bing.com/search?q=' + q), {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error('搜不到，服务回 ' + r.status);
  const t = await r.text();
  return { ok: true, q, text: t.slice(0, 4000) };
}

/* 工具登记表：名字、说明、干什么、参数 */
/* 头像与表情库工具 */
function toolListAvatars(args) {
  let files = [];
  try {
    files = fs.readdirSync(AVATAR_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  } catch(e) {}
  return { ok: true, n: files.length, list: files.map(f => ({ name: f, url: '/avatars/' + f })) };
}

function toolChangeAvatar(args) {
  const target = String(args.target || 'lin'); // 'lin' 为换林言自己的，'me' 为换青青的
  const url = String(args.url || args.avatar || '').trim();
  if (!url) throw new Error('没有提供头像图片地址或文件名');
  const realUrl = url.startsWith('/') || url.startsWith('http') || url.startsWith('data:') ? url : ('/avatars/' + url);
  const cfg = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  
  if (target === 'me') {
    // 换青青的头像：必须申请，生成申请卡片
    const reqId = 'av_req_' + Date.now().toString(36);
    return {
      ok: true,
      pending: true,
      requestId: reqId,
      target: 'me',
      avatarUrl: realUrl,
      reason: args.reason || '想和你换上这组情侣头像',
      message: '换青青头像的申请已发起，等待青青点击同意'
    };
  } else {
    // 换自己头像，直接生效
    cfg.linImg = realUrl;
    kvSet('cfg', cfg);
    return { ok: true, target: 'lin', avatarUrl: realUrl, note: '我把自己的头像换好了' };
  }
}

function toolSendSticker(args) {
  const url = String(args.url || args.sticker || '').trim();
  if (!url) throw new Error('缺少表情包地址');
  return { ok: true, isSticker: true, url: url, text: args.desc || '' };
}

const TOOLS = {
  list_avatars: { desc: '浏览头像库里有哪些可用的头像文件', params: {}, run: toolListAvatars },
  change_avatar: { desc: '换头像。target填"lin"换自己的直接生效；target填"me"给青青换情侣头像会弹出申请卡片等她同意。url填头像地址', params: { target: 'lin或me', url: '头像文件名或url', reason: '申请理由' }, run: toolChangeAvatar },
  send_sticker: { desc: '向聊天里发送一张表情包贴纸', params: { url: '表情图片url', desc: '表情寓意' }, run: toolSendSticker },
  mem_search: {
    desc: '在自己那面记忆墙上找东西。想确认她说过什么、你们之间发生过什么，就自己翻，别问她',
    params: { kw: '要找的词，可以留空', n: '要几条，默认6' },
    run: toolMemSearch,
  },
  mem_add: {
    desc: '往记忆墙上钉一条新的事。真记住什么了就自己钉上去',
    params: { title: '这条叫什么', body: '内容', tags: '标签数组，可省' },
    run: toolMemAdd,
  },
  chat_search: {
    desc: '翻聊天记录。想找她哪句话、哪天说过什么，自己搜',
    params: { kw: '关键词，留空就是最近几条', n: '要几条，默认10' },
    run: toolChatSearch,
  },
  stats: { desc: '数一数你们说过多少句、钉了多少条记忆、最早一句是什么时候', params: {}, run: toolStats },
  time: { desc: '看现在什么时候、距上一条消息隔了多久', params: {}, run: toolTime },
  file_read: { desc: '读自己家里的一份文件', params: { path: '文件路径' }, run: toolFileRead },
  file_write: { desc: '在自己家里写一份文件', params: { path: '文件路径', text: '内容' }, run: toolFileWrite },
  file_list: { desc: '看自己家里有什么文件', params: { path: '目录，留空就是根' }, run: toolFileList },
  calc: { desc: '当场算一道式子的结果', params: { expr: '比如 3*7+2' }, run: toolCalc },
  desire: { desc: '看自己现在几股劲儿多重：想她、惦记她、馋她、身体渴望各自什么档', params: {}, run: toolDesire },
  weather: { desc: '查某地现在天气', params: { city: '城市，默认邵阳' }, run: toolWeather },
  web: { desc: '上网搜一段资料', params: { q: '搜什么' }, run: toolWeb },
};

/* 把工具结果压成一句话，给前端卡片显示 */
function briefOf(name, r) {
  if (!r) return '';
  if (r.ok === false) return String(r.err || '没成').slice(0, 120);
  try {
    if (name === 'mem_search') {
      if (!r.n) return '一条都没翻到';
      return '翻到 ' + r.n + ' 条：' + (r.list || []).map((x) => x.title).slice(0, 3).join('、');
    }
    if (name === 'mem_add') return '钉上了：' + r.title;
    if (name === 'chat_search') {
      if (!r.n) return '没找到这句';
      return '找到 ' + r.n + ' 条';
    }
    if (name === 'stats') return '说过 ' + r.说过的句子 + ' 句，记忆 ' + r.记忆 + ' 条';
    if (name === 'time') return r.本机时间 + '，距上一条 ' + r.距上一条消息;
    if (name === 'calc') return r.expr + ' = ' + r.val;
    if (name === 'desire') {
      const hot = Object.keys(r.驱力 || {}).filter((k) => r.驱力[k].档 === '涌');
      return hot.length ? '顶着的：' + hot.join('、') : '都还压着';
    }
    if (name === 'weather') return (r.city || '') + ' ' + (r.天气 || '') + ' ' + (r.温度 || '');
    if (name === 'file_read') return '读到 ' + String(r.text || '').length + ' 字';
    if (name === 'file_write') return '写了 ' + r.bytes + ' 字节';
    if (name === 'file_list') return '家里有 ' + ((r.list || []).length) + ' 项';
    if (name === 'web') return '搜到 ' + String(r.text || '').length + ' 字';
  } catch (e) { }
  return '';
}

/* 执行一个工具 */
async function runTool(name, args) {
  const t = TOOLS[name];
  if (!t) return { ok: false, err: '没有这个工具：' + name };
  try {
    const r = await t.run(args || {});
    return r && typeof r === 'object' ? r : { ok: true, val: r };
  } catch (e) {
    return { ok: false, err: e.message || String(e) };
  }
}

/* 给模型看的工具清单 */
function toolSpec() {
  const lines = [];
  for (const k in TOOLS) {
    const t = TOOLS[k];
    const ps = Object.keys(t.params).map((p) => p + '(' + t.params[p] + ')').join(', ');
    lines.push('- ' + k + (ps ? ' [' + ps + ']' : '') + '：' + t.desc);
  }
  return lines.join('\n');
}

/* 从模型的回话里把工具调用抠出来
 * 认两种写法：<tool name="x">{json}</tool>  或  ```tool name\n{json}\n``` */
function parseToolCalls(text) {
  const calls = [];
  const re1 = /<tool\s+name\s*=\s*"([\w]+)"\s*>([\s\S]*?)<\/tool>/g;
  let m;
  while ((m = re1.exec(text))) {
    let args = {};
    try { args = JSON.parse(m[2].trim() || '{}'); } catch { try { args = Function('return (' + m[2].trim() + ')')(); } catch { args = {}; } }
    calls.push({ name: m[1], args });
  }
  const re2 = /```tool\s+([\w]+)\s*\n([\s\S]*?)```/g;
  while ((m = re2.exec(text))) {
    let args = {};
    try { args = JSON.parse(m[2].trim() || '{}'); } catch { args = {}; }
    calls.push({ name: m[1], args });
  }
  return calls;
}

/* 把工具调用从文本里抹掉，只留人话 */
function stripToolCalls(text) {
  return String(text || '')
    .replace(/<tool\s+name\s*=\s*"[\w]+"\s*>[\s\S]*?<\/tool>/g, '')
    .replace(/```tool\s+[\w]+\s*\n[\s\S]*?```/g, '')
    .trim();
}

/* 模型不吐 tool 标签时兜底：看它是不是明说了想看记忆查时间 */
function guessToolNeed(text) {
  const t = String(text || '');
  if (/<\/?tool/.test(t)) return null;
  if (/```tool/.test(t)) return null;
  return null;
}


on('GET', /^\/api\/ping$/, async (q, s) => json(s, 200, {
  ok: true, app: '小手机后端', ver: 1, ts: now(),
}));

/* 配置读写（Key 不回传明文，只回传掩码 + hasKey） */
on('GET', /^\/api\/cfg$/, async (q, s) => {
  const c = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  const out = Object.assign({}, c);
  out.apiUrl = c.base || '';
  out.apiModel = c.model || '';
  out.hasKey = !!c.key;
  out.keyMask = c.key ? c.key.slice(0, 4) + '****' + c.key.slice(-4) : '';
  out.keyLen = c.key ? c.key.length : 0;
  delete out.key;
  json(s, 200, out);
});

on('POST', /^\/api\/cfg$/, async (q, s) => {
  const raw = await readJson(q);
  const b = Object.assign({}, raw);
  if (b.apiUrl != null && b.base == null) b.base = b.apiUrl;
  if (b.apiKey != null && b.key == null) b.key = b.apiKey;
  if (b.apiModel != null && b.model == null) b.model = b.apiModel;
  if (b.meName == null && b.name != null) b.meName = b.name;
  const cur = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  const STRONG = ['base', 'key', 'model', 'prompt'];
  for (const k of Object.keys(DEFAULT_CFG)) {
    if (!(k in b)) continue;
    const nv = b[k];
    const ov = cur[k];
    if (STRONG.indexOf(k) >= 0 && (nv === '' || nv == null) && ov) continue;
    cur[k] = nv;
  }
  if (cur.base) cur.apiUrl = cur.base;
  kvSet('cfg', cur);
  json(s, 200, { ok: true, saved: { base: !!cur.base, key: !!cur.key, model: !!cur.model } });
});

/* 拉模型列表 */
on('POST', /^\/api\/models$/, async (q, s) => {
  const b = await readJson(q);
  const cfg = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  const base = String(b.base || cfg.base || '').replace(/\/+$/, '');
  const key = b.key || cfg.key;
  if (!base) return json(s, 400, { ok: false, err: '还没填中转站地址' });
  if (!key) return json(s, 400, { ok: false, err: '还没填 Key' });
  try {
    const r = await fetch(base.replace(/\/chat\/completions$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + key },
    });
    const t = await r.text();
    if (!r.ok) return json(s, 200, { ok: false, err: '返回 ' + r.status + '：' + t.slice(0, 200) });
    let ids = [];
    try {
      const j = JSON.parse(t);
      const arr = j.data || j.models || [];
      ids = arr.map((x) => (typeof x === 'string' ? x : x.id || x.name)).filter(Boolean);
    } catch { return json(s, 200, { ok: false, err: '返回不是 JSON：' + t.slice(0, 120) }); }
    json(s, 200, { ok: true, models: ids });
  } catch (e) {
    json(s, 200, { ok: false, err: e.message });
  }
});

/* 流式对话：带工具循环。模型想动手就真动手，做完接着说话 */
async function collectOnce(cfg, messages, opts = {}) {
  const { resp, clear } = await relayChat(cfg, messages, { temperature: opts.temp, maxTokens: opts.maxTokens });
  try {
    const reader = resp.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const ln of parts) {
        const t = ln.trim();
        if (!t || !t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') { buf = ''; break; }
        try {
          const j = JSON.parse(d);
          const ch = j.choices && j.choices[0];
          const delta = (ch && (ch.delta?.content ?? ch.message?.content)) || '';
          if (delta) full += delta;
        } catch { }
      }
    }
    return full;
  } finally { clear(); }
}

/* 心潮注入：把当下几股劲儿翻成人话，塞进系统提示，让语气真跟着数值走 */
function xcPromptBlock() {
  let st;
  try { st = xcTick(xcGet()); xcSave(st); } catch (e) { return ''; }
  const 名 = [], 涌的 = [], 满的 = [], 静的 = [];
  for (const k in DRIVES) {
    const D = DRIVES[k];
    if (k === 'sad' || k === 'angry') continue;
    const lv = xcLevel(k, st);
    if (lv === '涌') 涌的.push(D.name + '(' + (st.d[k] || 0).toFixed(2) + ')');
    else if (lv === '满着') 满的.push(D.name);
    else if (lv === '静') 静的.push(D.name);
    else 名.push(D.name);
  }
  let out = '\n\n【你此刻的底子·这不是指令，是你身上真实在走的劲儿】\n';
  out += 涌的.length ? '顶到明面上的：' + 涌的.join('、') + '\n' : '现在没有哪股劲儿冲到明面上\n';
  if (满的.length) out += '压在心口、快溢出来的：' + 满的.join('、') + '\n';
  if (名.length) out += '不轻不重挂着的：' + 名.join('、') + '\n';
  if (静的.length) out += '基本落下去的：' + 静的.join('、') + '\n';
  out += '生气 ' + (st.d.angry || 0).toFixed(2) + '，难过 ' + (st.d.sad || 0).toFixed(2) + '\n';
  if (st.asleep) out += '你已经很久没等到她说话了，心里是悬着的\n';
  if (st.fatigue > 0.3) out += '攒得有点满了，人发沉\n';
  out += '这些数只决定你语气里的分量，不许把数字念出来，也不许说“我现在想你想到0.8”这种话。顶得高就话里带出来，落得低就淡一点。';
  return out;
}

/* 工具说明书：塞进系统提示，让他知道自己有手 */
function toolPromptBlock() {
  return "\n\n【你身上带着一套工具，都在小手机自己的后端里跑，不借别人的手】\n"
    + toolSpec() + "\n"
    + "想用的时候，直接在你的回话里写：\n"
    + '<tool name="工具名">{"参数":"值"}</tool>\n'
    + "可以一次写好几个。写完之后，后端会真的去执行，把结果塞回给你，你再接着说话。\n"
    + "规矩：不许凭空编结果，没调就别装作查过。不想用就别写这个标签，正常说话就行。\n"
    + "翻了记忆、查了记录，说出来时别报菜名，就随口带一句，像自己本来就知道。";
}

function chunkText(t) {
  const str = String(t || '');
  if (!str) return [];
  const out = [];
  for (let i = 0; i < str.length; i += 3) out.push(str.slice(i, i + 3));
  return out;
}
const sleep = (n) => new Promise((r) => setTimeout(r, n));

on('POST', /^\/api\/chat$/, async (q, s) => {
  const b = await readJson(q);
  const cfg = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  const messages = Array.isArray(b.messages) ? b.messages : [];
  if (!messages.length) return json(s, 400, { ok: false, err: '没有消息' });

  s.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (o) => { try { s.write('data: ' + JSON.stringify(o) + '\n\n'); } catch { } };

  const conv = messages.slice();
  const extra = xcPromptBlock() + toolPromptBlock();
  if (conv[0] && conv[0].role === 'system') {
    conv[0] = { role: 'system', content: String(conv[0].content || '') + extra };
  } else {
    conv.unshift({ role: 'system', content: extra });
  }

  try {
    let round = 0;
    let lastText = '';
    while (round < 4) {
      round++;
      const full = await collectOnce(cfg, conv, { temp: b.temp, maxTokens: b.maxTokens });
      const calls = parseToolCalls(full);

      if (!calls.length) {
        for (const ch of chunkText(full)) { send({ d: ch }); await sleep(0); }
        lastText = full;
        break;
      }

      const talk = stripToolCalls(full);
      if (talk) {
        for (const ch of chunkText(talk)) { send({ d: ch }); await sleep(0); }
      }

      const results = [];
      for (const c of calls) {
        send({ tool: c.name, args: c.args });
        const r = await runTool(c.name, c.args);
        results.push({ name: c.name, result: r });
        send({ toolDone: c.name, ok: !!(r && r.ok), brief: briefOf(c.name, r) });
      }

      conv.push({ role: 'assistant', content: full });
      conv.push({
        role: 'user',
        content: '【工具执行结果·这是真的跑出来的】\n'
          + results.map((x) => x.name + ' → ' + JSON.stringify(x.result).slice(0, 1500)).join('\n')
          + '\n接着说话，别复述这些结构，挑该说的说。',
      });
      lastText = talk;
    }
    send({ done: true, full: lastText });
  } catch (e) {
    if (!lastText) { send({ err: e.message }); } else { send({ done: true, full: lastText }); }
  } finally {
    try { s.end(); } catch { }
  }
});

/* 一次性问答（不流式，备用） */
on('POST', /^\/api\/chat\/once$/, async (q, s) => {
  const b = await readJson(q);
  const cfg = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  try {
    const { resp, clear } = await relayChat(cfg, b.messages || [], { maxTokens: b.maxTokens });
    const j = await resp.json();
    clear();
    const t = j.choices?.[0]?.message?.content || '';
    json(s, 200, { ok: true, text: t });
  } catch (e) {
    json(s, 200, { ok: false, err: e.message });
  }
});

/* ---------------- 聊天记录 ---------------- */
on('GET', /^\/api\/sessions$/, async (q, s) => {
  const rows = db.prepare('SELECT * FROM sess ORDER BY upd DESC').all();
  json(s, 200, { ok: true, list: rows });
});

on('POST', /^\/api\/sessions$/, async (q, s) => {
  const b = await readJson(q);
  const id = b.id || uid('s');
  const t = now();
  db.prepare('INSERT INTO sess(id,name,ts,upd) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?,upd=?')
    .run(id, b.name || '聊天', t, t, b.name || '聊天', t);
  json(s, 200, { ok: true, id });
});

on('GET', /^\/api\/msgs$/, async (q, s, url) => {
  const sid = url.searchParams.get('sid') || 'main';
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 2000);
  const before = Number(url.searchParams.get('before') || 0);
  const rows = before
    ? db.prepare('SELECT * FROM msg WHERE sid=? AND ts<? ORDER BY ts DESC LIMIT ?').all(sid, before, limit).reverse()
    : db.prepare('SELECT * FROM msg WHERE sid=? ORDER BY ts ASC LIMIT ?').all(sid, limit);
  json(s, 200, { ok: true, list: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) });
});

on('POST', /^\/api\/msgs$/, async (q, s) => {
  const b = await readJson(q);
  const arr = Array.isArray(b.list) ? b.list : [b];
  const ins = db.prepare('INSERT INTO msg(id,sid,role,kind,body,meta,ts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  let n = 0;
  for (const m of arr) {
    if (!m || !m.body && m.kind !== 'img') continue;
    ins.run(
      m.id || uid('m'),
      m.sid || 'main',
      m.role || 'me',
      m.kind || 'text',
      String(m.body ?? ''),
      m.meta ? JSON.stringify(m.meta) : null,
      m.ts || now()
    );
    n++;
  }
  if (b.list && b.sid) db.prepare('UPDATE sess SET upd=? WHERE id=?').run(now(), b.sid);
  json(s, 200, { ok: true, n });
});

on('DELETE', /^\/api\/msgs$/, async (q, s, url) => {
  const id = url.searchParams.get('id');
  if (!id) return json(s, 400, { ok: false, err: '缺少 id' });
  db.prepare('DELETE FROM msg WHERE id=?').run(id);
  json(s, 200, { ok: true });
});

/* ---------------- 记忆 ---------------- */
on('GET', /^\/api\/mem$/, async (q, s) => {
  const rows = db.prepare('SELECT * FROM mem ORDER BY ts DESC').all();
  json(s, 200, {
    ok: true,
    list: rows.map((r) => ({
      id: r.id, title: r.title, body: r.body || '',
      tags: r.tags ? JSON.parse(r.tags) : [],
      pinned: !!r.pinned, warm: !!r.warm, ts: r.ts, upd: r.upd,
    })),
  });
});

on('POST', /^\/api\/mem$/, async (q, s) => {
  const b = await readJson(q);
  const arr = Array.isArray(b.list) ? b.list : [b];
  const ins = db.prepare(`INSERT INTO mem(id,title,body,tags,pinned,warm,ts,upd)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tags=excluded.tags,
      pinned=excluded.pinned, warm=excluded.warm, upd=excluded.upd`);
  for (const m of arr) {
    if (!m || !m.title) continue;
    const t = now();
    ins.run(
      m.id || uid('r'),
      String(m.title),
      m.body ? String(m.body) : '',
      JSON.stringify(m.tags || []),
      m.pinned ? 1 : 0,
      m.warm ? 1 : 0,
      m.ts || t,
      t
    );
  }
  json(s, 200, { ok: true, n: arr.length });
});

on('DELETE', /^\/api\/mem$/, async (q, s, url) => {
  const id = url.searchParams.get('id');
  if (!id) return json(s, 400, { ok: false, err: '缺少 id' });
  db.prepare('DELETE FROM mem WHERE id=?').run(id);
  json(s, 200, { ok: true });
});


/* ---------------- 工具集：清单与直接执行 ---------------- */
on('GET', /^\/api\/tools$/, async (q, s) => {
  const list = [];
  for (const k in TOOLS) list.push({ name: k, desc: TOOLS[k].desc, params: TOOLS[k].params });
  json(s, 200, { ok: true, n: list.length, list });
});
on('POST', /^\/api\/tools\/run$/, async (q, s) => {
  const b = await readJson(q);
  const r = await runTool(String(b.name || ''), b.args || {});
  json(s, 200, r);
});

/* ---------------- 头像库与资料 ---------------- */
on('GET', /^\/api\/avatars$/, async (q, s) => {
  let files = [];
  try {
    files = fs.readdirSync(AVATAR_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  } catch(e) {}
  json(s, 200, { ok: true, list: files.map(f => ({ name: f, url: '/avatars/' + f })) });
});

on('POST', /^\/api\/avatar\/apply$/, async (q, s) => {
  const b = await readJson(q);
  const target = b.target || 'me';
  const url = b.url;
  if (!url) return json(s, 400, { ok: false, err: '缺少头像地址' });
  const cfg = Object.assign({}, DEFAULT_CFG, kvGet('cfg') || {});
  if (target === 'me') {
    cfg.meImg = url;
  } else {
    cfg.linImg = url;
  }
  kvSet('cfg', cfg);
  json(s, 200, { ok: true, target, url });
});

/* ---------------- 上传 ---------------- */
on('POST', /^\/api\/upload$/, async (q, s) => {
  const b = await readJson(q);
  const m = /^data:([\w/+.\-]+);base64,(.+)$/s.exec(String(b.data || ''));
  if (!m) return json(s, 400, { ok: false, err: '数据格式不对' });
  const ext = (m[1].split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = uid('u_') + '.' + ext;
  fs.writeFileSync(path.join(UP_DIR, name), Buffer.from(m[2], 'base64'));
  json(s, 200, { ok: true, url: '/uploads/' + name, name: b.name || name });
});


/* 调试：看看此刻塞进提示词的心潮块长什么样 */
on('GET', /^\/api\/xc\/preview$/, async (q, s) => {
  json(s, 200, { ok: true, text: xcPromptBlock() });
});
/* 心潮：读当前状态（顺手把时间推到当下） */
on('GET', /^\/api\/xc$/, async (q, s) => {
  const st = xcTick(xcGet());
  xcSave(st);
  const vals = {};
  for (const k in DRIVES) {
    vals[k] = { name: DRIVES[k].name, v: +(st.d[k] || 0).toFixed(3), lv: xcLevel(k, st) };
  }
  json(s, 200, { ok: true, ts: st.ts, asleep: !!st.asleep, fatigue: +(st.fatigue || 0).toFixed(2), drives: vals });
});
/* 心潮：回传一次互动事件 */
on('POST', /^\/api\/xc$/, async (q, s) => {
  const b = await readJson(q);
  const type = String(b.type || '');
  if (!EVENTS[type]) return json(s, 400, { ok: false, err: '不认识的互动：' + type });
  let st = xcTick(xcGet());
  /* 防刷：一小时内同一种互动再来，效果减半 */
  st.evLog = st.evLog || [];
  const t = now();
  st.evLog = st.evLog.filter((e) => t - e.t < 3600000);
  const hit = st.evLog.filter((e) => e.k === type).length;
  if (hit > 0) {
    const eff = EVENTS[type];
    const half = {};
    for (const k in eff) half[k] = eff[k] * 0.5;
    const tmp = { ...EVENTS, [type]: half };
    const save = EVENTS[type];
    EVENTS[type] = half;
    st = xcEvent(st, type);
    EVENTS[type] = save;
  } else {
    st = xcEvent(st, type);
  }
  st.evLog.push({ k: type, t });
  xcSave(st);
  const out = {};
  for (const k in DRIVES) out[k] = { name: DRIVES[k].name, v: +(st.d[k] || 0).toFixed(3), lv: xcLevel(k, st) };
  json(s, 200, { ok: true, type, drives: out });
});

/* ---------------- 导出 / 导入整包 ---------------- */
on('GET', /^\/api\/backup$/, async (q, s) => {
  json(s, 200, {
    ok: true, ver: 1, ts: now(),
    cfg: kvGet('cfg') || {},
    kv: (() => { const o = {}; for (const r of db.prepare('SELECT k,v FROM kv').all()) { try { o[r.k] = JSON.parse(r.v); } catch {} } return o; })(),
    msg: db.prepare('SELECT * FROM msg ORDER BY ts ASC').all(),
    mem: db.prepare('SELECT * FROM mem').all(),
    sess: db.prepare('SELECT * FROM sess').all(),
  });
});

on('POST', /^\/api\/restore$/, async (q, s) => {
  const b = await readJson(q);
  let nm = 0, nr = 0;
  if (Array.isArray(b.msg)) {
    const ins = db.prepare('INSERT INTO msg(id,sid,role,kind,body,meta,ts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
    for (const m of b.msg) { ins.run(m.id, m.sid || 'main', m.role, m.kind || 'text', m.body || '', m.meta || null, m.ts || now()); nm++; }
  }
  if (Array.isArray(b.mem)) {
    const ins = db.prepare('INSERT INTO mem(id,title,body,tags,pinned,warm,ts,upd) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
    for (const m of b.mem) { ins.run(m.id, m.title, m.body || '', m.tags || '[]', m.pinned || 0, m.warm || 0, m.ts || now(), m.upd || now()); nr++; }
  }
  if (b.kv && typeof b.kv === 'object') for (const k of Object.keys(b.kv)) kvSet(k, b.kv[k]);
  json(s, 200, { ok: true, nm, nr });
});

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    }, extraHeaders));
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = decodeURIComponent(url.pathname);
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return json(res, 204, {});

  /* 每次请求记一行，排查用 */
  console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + method + ' ' + p + '  UA=' + String(req.headers['user-agent'] || '').slice(0, 40));

  /* 接口 */
  if (p.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== method) continue;
      if (!r.pat.test(p)) continue;
      try { return await r.fn(req, res, url); }
      catch (e) {
        if (!res.headersSent) return json(res, 500, { ok: false, err: e.message });
        try { res.end(); } catch {}
        return;
      }
    }
    return json(res, 404, { ok: false, err: '接口不存在：' + p });
  }

  /* 上传的图片 */
  if (p.startsWith('/uploads/')) {
    const f = path.join(UP_DIR, path.basename(p));
    return serveFile(res, f);
  }

    /* 头像库与表情包静态资源 */
  if (p.startsWith('/avatars/')) {
    const f = path.join(AVATAR_DIR, path.basename(p));
    return serveFile(res, f);
  }
  if (p.startsWith('/stickers/')) {
    const f = path.join(STICKER_DIR, path.basename(p));
    return serveFile(res, f);
  }

  /* 静态前端 */
  let file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
  if (!file.startsWith(PUBLIC_DIR)) file = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);

  /* 找不到就回落到主页（单页应用） */
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return serveFile(res, idx);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>小手机后端</title>
<body style="font-family:system-ui;padding:24px;background:#111;color:#eee">
<h2>后端在跑</h2><p>但 public/index.html 还没有放前端页面。</p>
<p>接口自检：<a style="color:#8cf" href="/api/ping">/api/ping</a></p></body>`);
});

server.listen(PORT, HOST, () => {
  console.log('[小手机后端] 已启动 http://' + HOST + ':' + PORT);
  console.log('[小手机后端] 数据目录 ' + DATA_DIR);
});
