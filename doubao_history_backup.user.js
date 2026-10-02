// ==UserScript==
// @name         豆包历史备份器
// @namespace    https://github.com/Yinyuan34513/doubao-history-backup
// @version      1.2.2
// @description  拦截豆包历史 API 并自动翻页刷新，IndexedDB 缓存增量同步（不重复抓已抓齐会话），导出 history/<会话名>/main.md ZIP
// @author       Yinyuan34513
// @match        https://doubao.com/*
// @match        https://www.doubao.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================ 常量 ============================
  const POLL_MS = 60000;               // 轮询间隔：持续刷新新历史
  const LIST_LIMIT = 50;               // recent_conv 每页会话数
  const CHAIN_LIMIT = 20;              // chain/single 每页消息数
  const ANCHOR_MAX = 9007199254740991; // 初始 anchor_index (MAX_SAFE_INTEGER)
  const CONV_DELAY = 6;              // 单个 worker 的会话间隔（防限流）
  const MSG_CONCURRENCY = 90;          // 并发抓消息 worker 数（实测豆包不限流，直接拉满；要改数值就改这里）

  // 需要拦截/主动调用的历史相关 API（pathname 后缀匹配）
  const HISTORY_PATHS = [
    '/im/chain/recent_conv',     // 会话列表 (cmd 3200)
    '/im/chain/single',          // 消息链   (cmd 3100)
    '/im/conversation/info',     // 单会话信息 (cmd 1110)
    '/im/conversation/batch_get',// 批量会话信息 (cmd 1111)
    '/alice/profile/self'        // 个人资料（用户名）
  ];

  // ============================ 工具 ============================
  const enc = new TextEncoder();

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // 去掉零宽/不可见字符（豆包昵称里混有大量 ZWJ）
  function stripZW(s) {
    return String(s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u061C\u00AD]/g, '');
  }

  // 文件夹/文件名安全化
  function sanitize(name, fallback) {
    let s = stripZW(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '');
    if (!s) s = fallback;
    return s.length > 80 ? s.slice(0, 80) : s;
  }

  // D/M/Y
  function fmtDate(sec) {
    const n = Number(sec);
    if (!n) return '未知';
    const d = new Date(n * 1000);
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }

  function parseCookies() {
    const out = {};
    document.cookie.split(';').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
    });
    return out;
  }

  // ============================ 日志 ============================
  const logs = [];
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    logs.push(`[${t}] ${msg}`);
    if (logs.length > 200) logs.shift();
    const box = document.getElementById('dbb-logbox');
    if (box) box.textContent = logs.join('\n');
    console.log('[豆包历史备份器]', msg);
  }

  // ============================ 状态 ============================
  const state = {
    nickname: '',                 // 用户名
    urls: {},                     // pathname -> 完整 URL（从页面流量学习）
    convs: new Map(),             // id -> {id,name,type,create,update,syncedTo}
    msgs: new Map(),              // id -> Map(message_id -> message)
    syncing: false,
    listPages: 0,                 // 已翻列表页数（响应无总数，翻到 has_more=false 为止）
    cacheLoaded: false            // IndexedDB 缓存是否已载入
  };

  // ============================ IndexedDB 缓存 ============================
  // 跨刷新复用已抓数据：会话元数据 + 每个会话的消息，增量写入，
  // 刷新/重开页面后只需补抓 update_time 有变化的会话（不重复全量抓取）。
  const DB_NAME = 'doubao_history_backup';
  const DB_VER = 1;
  let dbPromise = null;
  let idbBroken = false;          // IndexedDB 不可用（隐私模式等）时置位，静默降级为纯内存

  function idbOpen() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB 不可用')); return; }
        const rq = indexedDB.open(DB_NAME, DB_VER);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains('convs')) d.createObjectStore('convs', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('msgs')) d.createObjectStore('msgs', { keyPath: 'convId' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
        rq.onblocked = () => reject(new Error('IndexedDB 被占用'));
      } catch (e) { reject(e); }
    });
    dbPromise.catch(() => {});
    return dbPromise;
  }

  function idbTx(store, mode, fn) {
    // fn(store) 内注册请求；返回 Promise，失败只记一次日志
    if (idbBroken) return Promise.resolve();
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(store, mode); } catch (e) { reject(e); return; }
      try { fn(tx.objectStore(store)); } catch (e) { try { tx.abort(); } catch (_) {} reject(e); return; }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入中止'));
    })).catch((e) => {
      if (!idbBroken) { idbBroken = true; log('IndexedDB 不可用，降级为内存模式: ' + e.message); }
    });
  }

  const idbPut = (store, val) => idbTx(store, 'readwrite', (s) => s.put(val));
  const idbPutAll = (store, vals) => idbTx(store, 'readwrite', (s) => { for (const v of vals) s.put(v); });

  function idbGetAll(store) {
    if (idbBroken) return Promise.resolve([]);
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    })).catch(() => []);
  }

  function serializeConv(c) {
    return { id: c.id, name: c.name, type: c.type, create: c.create, update: c.update, syncedTo: c.syncedTo || 0 };
  }

  function saveConv(c) { return idbPut('convs', serializeConv(c)); }

  function saveMsgs(convId, map) {
    return idbPut('msgs', { convId, list: [...map.values()] });
  }

  function saveNickname(nick) { return idbPut('meta', { k: 'nickname', v: nick }); }

  async function loadCache() {
    if (state.cacheLoaded) return;
    state.cacheLoaded = true;
    try {
      const [convs, msgRecs, nickRecs] = await Promise.all([
        idbGetAll('convs'), idbGetAll('msgs'), idbGetAll('meta')
      ]);
      if (idbBroken) return;
      let nConv = 0;
      for (const c of convs) {
        if (!c || !c.id) continue;
        state.convs.set(c.id, {
          id: c.id, name: c.name || '', type: c.type || 3,
          create: Number(c.create) || 0, update: Number(c.update) || 0, syncedTo: Number(c.syncedTo) || 0
        });
        nConv++;
      }
      let nMsgConv = 0, nMsg = 0;
      for (const r of msgRecs) {
        if (!r || !r.convId) continue;
        const map = new Map();
        for (const m of r.list || []) map.set(String(m.message_id != null ? m.message_id : m.index_in_conv), m);
        state.msgs.set(r.convId, map);
        nMsgConv++; nMsg += map.size;
        // 缓存里有会话记录但缺 syncedTo（异常中断）→ 用 update_time 兜底，避免永久待抓
        const c = state.convs.get(r.convId);
        if (c && !c.syncedTo && c.update) c.syncedTo = c.update;
      }
      for (const kr of nickRecs) if (kr.k === 'nickname' && kr.v && !state.nickname) state.nickname = kr.v;
      if (nConv || nMsgConv) {
        log(`缓存命中：${nConv} 会话 / ${nMsgConv} 个已抓会话 ${nMsg} 条消息（IndexedDB）`);
      }
    } catch (e) {
      log('缓存加载失败: ' + e.message);
    }
  }


  // ============================ 网络层 ============================
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const origFetch = W.fetch.bind(W);

  function fallbackQuery() {
    const c = parseCookies();
    const p = new URLSearchParams({
      version_code: '20800',
      language: 'zh',
      device_platform: 'web',
      doubao_device_platform: 'web',
      aid: '497858',
      real_aid: '497858',
      pkg_type: 'release_version',
      pc_version: '3.39.2',
      doubao_pc_version: '3.39.2',
      region: 'CN',
      sys_region: 'CN',
      samantha_web: '1',
      web_platform: 'browser',
      'use-olympus-account': '1',
      web_tab_id: uuid()
    });
    if (c.device_id) p.set('device_id', c.device_id);
    if (c.web_id) p.set('web_id', c.web_id);
    if (c.tea_uuid) p.set('tea_uuid', c.tea_uuid);
    return p.toString();
  }

  function apiUrl(path) {
    return state.urls[path] || (location.origin + path + '?' + fallbackQuery());
  }

  async function api(path, payload) {
    const tried = [];
    // 先用学习到的 URL，失败则回退到动态构造的 URL 再试一次
    for (const url of state.urls[path] ? [state.urls[path], location.origin + path + '?' + fallbackQuery()]
                                       : [location.origin + path + '?' + fallbackQuery()]) {
      if (tried.includes(url)) continue;
      tried.push(url);
      try {
        const res = await origFetch(url, {
          method: 'POST',
          headers: {
            // 字节 API 网关要求 content-type 带 encoding=utf-8，否则返回 712012002 "不支持编码类型"
            'content-type': 'application/json; encoding=utf-8',
            'accept': 'application/json, text/plain, */*',
            'agw-js-conv': 'str'
          },
          credentials: 'include',
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j && j.status_code && Number(j.status_code) !== 0) {
          const err = new Error(`服务端 ${j.status_code}: ${j.status_desc || '未知错误'}`);
          err.biz = true; // 业务错误 ≠ URL 失效，不应删除学习到的 URL
          throw err;
        }
        return j;
      } catch (e) {
        if (e.biz) throw e;
        if (state.urls[path] === url) { delete state.urls[path]; log(`URL 失效，切换: ${path} (${e.message})`); }
        if (url === tried[tried.length - 1]) throw e;
      }
    }
    throw new Error('api unreachable: ' + path);
  }

  // ============================ 数据入库 ============================
  function upsertConv(meta) {
    if (!meta || !meta.id) return null;
    let c = state.convs.get(meta.id);
    if (!c) {
      c = { id: meta.id, name: '', type: 3, create: 0, update: 0, syncedTo: 0 };
      state.convs.set(meta.id, c);
    }
    if (meta.name) c.name = meta.name;
    if (meta.type) c.type = meta.type;
    if (meta.create) c.create = Number(meta.create);
    if (meta.update) c.update = Number(meta.update);
    return c;
  }

  function ingestList(json) {
    const b = json && json.downlink_body && json.downlink_body.pull_recent_conv_chain_downlink_body;
    if (!b) return [];
    const ids = [];
    for (const cell of b.cells || []) {
      const conv = cell.conversation;
      if (!conv || !conv.conversation_id) continue;
      upsertConv({
        id: conv.conversation_id,
        name: conv.name,
        type: conv.conversation_type,
        create: conv.create_time,
        update: conv.update_time
      });
      ids.push(conv.conversation_id);
    }
    return ids;
  }

  function ingestMessages(convId, json, replace) {
    const b = json && json.downlink_body && json.downlink_body.pull_singe_chain_downlink_body;
    if (!b) return 0;
    let map = state.msgs.get(convId);
    if (!map || replace) { map = new Map(); state.msgs.set(convId, map); }
    for (const m of b.messages || []) {
      const key = m.message_id || m.index_in_conv;
      map.set(String(key), m);
    }
    return map.size;
  }

  function ingestConvInfo(json) {
    const b = json && json.downlink_body && json.downlink_body.get_conv_info_downlink_body;
    const info = b && b.conversation_info;
    if (!info || !info.conversation_id) return;
    upsertConv({
      id: info.conversation_id,
      name: info.name,
      type: info.conversation_type,
      create: info.create_time,
      update: info.update_time
    });
  }

  function pickHumanNick(participants) {
    for (const p of participants || []) {
      if (String(p.user_type) === '1' && p.nick_name) return stripZW(p.nick_name);
    }
    return '';
  }

  function ingestBatchGet(json) {
    const b = json && json.downlink_body && json.downlink_body.batch_get_conv_info_downlink_body;
    if (!b) return;
    for (const info of b.conversation_info_list || []) {
      upsertConv({
        id: info.conversation_id,
        name: info.name,
        type: info.conversation_type,
        create: info.create_time,
        update: info.update_time
      });
      if (!state.nickname) {
        const nick = pickHumanNick(info.first_page_participant_list);
        if (nick) { state.nickname = nick; log('获取用户名: ' + nick); }
      }
    }
  }

  function ingestProfile(json) {
    const brief = json && json.data && json.data.profile_brief;
    if (brief && brief.nickname) {
      state.nickname = stripZW(brief.nickname);
      log('获取用户名: ' + state.nickname);
    }
  }

  function handleJson(path, json, reqBody) {
    switch (path) {
      case '/im/chain/recent_conv': {
        const ids = ingestList(json);
        log(`页面流入会话列表: ${ids.length} 个`);
        break;
      }
      case '/im/chain/single': {
        let convId = '';
        try { convId = JSON.parse(reqBody || '{}').uplink_body.pull_singe_chain_uplink_body.conversation_id || ''; } catch (e) {}
        if (convId) {
          ingestMessages(convId, json, false);
          log(`页面流入消息: 会话 ${convId}`);
        }
        break;
      }
      case '/im/conversation/info': ingestConvInfo(json); break;
      case '/im/conversation/batch_get': ingestBatchGet(json); break;
      case '/alice/profile/self': ingestProfile(json); break;
    }
    renderList();
  }

  // ============================ 拦截页面流量 ============================
  function matchPath(url) {
    try {
      const p = new URL(url, location.href).pathname;
      for (const h of HISTORY_PATHS) if (p.endsWith(h)) return { path: h, full: new URL(url, location.href).href };
    } catch (e) {}
    return null;
  }

  function learnAndParse(m, reqBody, jsonGetter) {
    if (!m) return;
    if (!state.urls[m.path]) state.urls[m.path] = m.full;
    try {
      const json = typeof jsonGetter === 'function' ? jsonGetter() : jsonGetter;
      if (json) handleJson(m.path, json, reqBody);
    } catch (e) { /* 忽略解析失败 */ }
  }

  function patchWindow(win) {
    // --- fetch ---
    const of = win.fetch;
    if (typeof of === 'function' && !win.__dbbFetchPatched) {
      win.__dbbFetchPatched = true;
      win.fetch = async function (input, init) {
        let url = '', reqBody = null;
        try {
          if (typeof input === 'string') {
            url = input;
          } else if (input && input.url) {
            url = input.url;
            if (init === undefined) { try { reqBody = await input.clone().text(); } catch (e) {} }
          }
          if (init && typeof init.body === 'string') reqBody = init.body;
        } catch (e) {}
        const m = matchPath(url);
        const res = await of.apply(this, arguments);
        if (m) {
          learnAndParse(m, reqBody, () => res.clone().json());
        }
        return res;
      };
    }
    // --- XHR ---
    const xp = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (xp && !xp.__dbbXhrPatched) {
      xp.__dbbXhrPatched = true;
      const oopen = xp.open, osend = xp.send;
      xp.open = function (method, u) {
        this.__dbbUrl = u;
        return oopen.apply(this, arguments);
      };
      xp.send = function (body) {
        const xhr = this;
        xhr.addEventListener('load', () => {
          const m = matchPath(xhr.__dbbUrl || '');
          if (!m) return;
          learnAndParse(m, typeof body === 'string' ? body : null, () => {
            if (xhr.responseType === '' || xhr.responseType === 'text') return JSON.parse(xhr.responseText);
            if (xhr.response && typeof xhr.response === 'object') return xhr.response;
            return JSON.parse(xhr.responseText);
          });
        });
        return osend.apply(this, arguments);
      };
    }
  }

  patchWindow(W);

  // ============================ 主动同步 ============================
  // 列表请求：第 1 页复刻豆包初始加载参数；后续页复刻豆包滚动翻页参数
  // （豆包下一页 = conv_version 填上一页响应的 next_conv_version + direction:1）
  async function fetchListOnce(cursor) {
    const first = !cursor;
    const payload = {
      cmd: 3200,
      uplink_body: {
        pull_recent_conv_chain_uplink_body: {
          limit: LIST_LIMIT,
          filter: first
            ? { conversation_type: [], project_filter: 0, device_filter: 1 }
            : { conversation_type: [], project_filter: 1 },
          message_count_per_conv: 0,
          api_version: 1,
          conv_version: first ? 0 : cursor,
          direction: first ? 3 : 1,
          option: {
            not_need_message: true,
            need_complete_conversation: true,
            need_coco_bot: first,
            need_pc_pin_chain: true,
            pc_pin_query_type: 1,
            exclude_archive: true,
            only_archive: false
          }
        }
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1'
    };
    return api('/im/chain/recent_conv', payload);
  }

  // 拉取会话列表（按豆包翻页机制翻到 has_more=false；响应无 total，总数不可知）
  // 增量优化：列表按 update_time 倒序，一旦某一页全部是"已抓齐且未变化"的会话，
  // 更旧的页不可能有新会话/变更会话（变更会冒泡到顶部），即可提前停止 —— 已同步后每轮只翻 1 页。
  async function fetchAllList() {
    const seenCursors = new Set();
    let cursor = 0, total = 0, guard = 0;
    while (guard++ < 200) {
      const j = await fetchListOnce(cursor);
      const b = j && j.downlink_body && j.downlink_body.pull_recent_conv_chain_downlink_body;
      if (!b) break;
      const ids = ingestList(j);
      total += ids.length;
      state.listPages++;
      const clean = ids.length > 0 && ids.every((id) => {
        const c = state.convs.get(id);
        return c && Number(c.syncedTo || 0) > 0 && Number(c.update) <= Number(c.syncedTo);
      });
      if (clean) break;
      if (!b.has_more) break;
      const nv = b.next_conv_version;
      if (!nv || seenCursors.has(String(nv))) break;
      seenCursors.add(String(nv));
      cursor = Number(nv);
      await delay(CONV_DELAY);
    }
    return total;
  }

  // 拉取单个会话全部消息（分页方向：从新到旧）
  async function fetchChain(c) {
    let anchor = ANCHOR_MAX, guard = 0;
    const map = new Map();
    while (guard++ < 500) {
      const payload = {
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: c.id,
            anchor_index: anchor,
            conversation_type: c.type || 3,
            direction: 1,
            limit: CHAIN_LIMIT,
            ext: {},
            filter: { index_list: [] },
            evaluate_ab_params: '',
            evaluate_common_params: '',
            option: { lazy_load_strategy: 0 }
          }
        },
        sequence_id: uuid(),
        channel: 2,
        version: '1'
      };
      const j = await api('/im/chain/single', payload);
      const b = j && j.downlink_body && j.downlink_body.pull_singe_chain_downlink_body;
      if (!b) break;
      for (const m of b.messages || []) map.set(String(m.message_id || m.index_in_conv), m);
      if (!b.has_more) break;
      const ni = Number(b.next_index);
      if (!isFinite(ni) || ni === anchor) break;
      anchor = ni;
      await delay(80);
    }
    // 保护：拉到空结果时不覆盖已有数据（例如服务端偶发错误时）
    const prev = state.msgs.get(c.id);
    if (map.size === 0 && prev && prev.size > 0) {
      return prev.size;
    }
    state.msgs.set(c.id, map);
    saveMsgs(c.id, map);          // 增量落 IndexedDB，刷新后可复用
    return map.size;
  }

  // 用户名兜底：批量会话信息里取 user_type=1 的参与者昵称
  async function fetchNickname(ids) {
    if (state.nickname || !ids.length) return;
    try {
      const j = await api('/im/conversation/batch_get', {
        cmd: 1111,
        uplink_body: {
          batch_get_conv_info_uplink_body: {
            conversation_id: ids.slice(0, 10),
            option: { recent_message_count_per_conv: 1 },
            ext: {}
          }
        },
        sequence_id: uuid(),
        channel: 2,
        version: '1'
      });
      ingestBatchGet(j);
    } catch (e) { log('获取用户名失败: ' + e.message); }
  }

  function needsSync(c) {
    // 已抓齐（syncedTo 落位）且 update_time 没有变化的会话一律跳过 —— 不重复抓
    const s = Number(c.syncedTo || 0);
    if (s <= 0) return true;                       // 从未抓齐（含空会话，抓完也会落 syncedTo）
    return Number(c.update || 0) > s;              // 会话自上次抓取后有更新
  }

  function setStatus(s) {
    const el = document.getElementById('dbb-status');
    if (el) el.textContent = s;
  }

  async function runSync() {
    if (state.syncing) { log('同步进行中，跳过本次'); return; }
    state.syncing = true;
    const btns = ['dbb-sync', 'dbb-export'].map((id) => document.getElementById(id));
    btns.forEach((b) => b && (b.disabled = true));
    try {
      await loadCache();                           // 先复用 IndexedDB 里的旧数据
      setStatus('同步会话列表…');
      await fetchAllList();
      const convs = [...state.convs.values()];
      const ids = convs.map((c) => c.id);
      await fetchNickname(ids);
      if (state.nickname) saveNickname(state.nickname);
      idbPutAll('convs', convs.map(serializeConv));        // 列表元数据批量落库
      const queue = convs.filter(needsSync).sort((a, b) => b.update - a.update);
      log(`列表同步完成，共 ${convs.length} 个会话，待抓取消息 ${queue.length} 个`);
      // 并发 worker 池：每个 worker 独立顺序抓，worker 之间并行（提速且各自保持间隔防限流）
      let cursor = 0, done = 0;
      const total = queue.length;
      const worker = async () => {
        while (cursor < total) {
          const c = queue[cursor++];
          setStatus(`抓取消息 ${++done}/${total}`);
          try {
            const up = c.update;                     // 抓取前的 update_time 快照
            const n = await fetchChain(c);
            c.syncedTo = up;                         // 无论抓到多少条（含 0 条）都标记已抓齐
            saveConv(c);
            log(`✓ ${c.name || c.id} (${n} 条)`);
          } catch (e) {
            log(`✗ ${c.name || c.id}: ${e.message}`);   // 失败不落 syncedTo，下轮自动重试
          }
          await delay(CONV_DELAY);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MSG_CONCURRENCY, total) }, worker));
      renderList();
      const totalMsgs = [...state.msgs.values()].reduce((s, m) => s + m.size, 0);
      setStatus('已同步');
      log(`同步完成：${state.convs.size} 会话 / ${totalMsgs} 消息 / 列表累计翻页 ${state.listPages} 页`);
    } catch (e) {
      setStatus('同步失败');
      log('同步失败: ' + e.message);
    } finally {
      state.syncing = false;
      btns.forEach((b) => b && (b.disabled = false));
    }
  }

  // ============================ Markdown 生成 ============================
  function extractText(m) {
    const parts = [];
    for (const b of m.content_block || []) {
      const c = b.content || {};
      if (Number(b.block_type) === 10000 && c.text_block) parts.push(c.text_block.text || '');
    }
    const joined = parts.join('');
    if (joined.trim()) return joined;
    if ((m.content || '').trim()) return m.content;
    // 无文本但带图片附件块
    for (const b of m.content_block || []) {
      if (Number(b.block_type) === 10052) return '[图片附件]';
    }
    return '';
  }

  function extractThink(m) {
    if ((m.thinking_content || '').trim()) return m.thinking_content.trim();
    for (const b of m.content_block || []) {
      const c = b.content || {};
      if (Number(b.block_type) === 10040 && c.thinking_block) {
        const t = c.thinking_block.text || c.thinking_block.thinking || c.thinking_block.content || '';
        if (String(t).trim()) return String(t).trim();
      }
    }
    return '';
  }

  function extractImages(m) {
    const urls = [];
    for (const b of m.content_block || []) {
      const c = b.content || {};
      if (c.creation_block) {
        for (const cr of c.creation_block.creations || []) {
          const img = cr.image || {};
          const u = img.url || img.origin_url || img.image_url || cr.url;
          if (u) urls.push(u);
        }
      }
    }
    return urls;
  }

  function modelName(m) {
    const ext = m.ext || {};
    try {
      const bs = typeof ext.bot_state === 'string' ? JSON.parse(ext.bot_state) : ext.bot_state;
      if (bs && bs.bot_name) return bs.bot_name;
    } catch (e) {}
    if (ext.bot_name) return ext.bot_name;
    return '豆包';
  }

  function buildMd(c, msgs, nickname) {
    const L = [];
    L.push(`# ${c.name || '会话_' + c.id}`);
    L.push(`**Session ID:** ${c.id}`);
    L.push(`**Created:** ${fmtDate(c.create)}`);
    L.push(`**Updated:** ${fmtDate(c.update)}`);
    L.push('');
    L.push('---');
    const sorted = [...msgs].sort((a, b) => Number(a.index_in_conv) - Number(b.index_in_conv));
    for (const m of sorted) {
      const isUser = Number(m.user_type) === 1;
      const text = extractText(m);
      const think = extractThink(m);
      const imgs = extractImages(m);
      const imgMd = imgs.map((u) => `![image](${u})`).join('\n');
      L.push('');
      if (isUser) {
        L.push(`## User(Name: ${nickname})`);
        L.push(text);
        if (imgMd) L.push(imgMd);
      } else {
        L.push(`## Assistant(Model: ${modelName(m)})`);
        if (think) {
          L.push('_Thinking:_');
          L.push(think);
          L.push('');
        }
        L.push('Body:');
        L.push(text);
        if (imgMd) L.push(imgMd);
      }
      L.push('');
      L.push('---');
    }
    return L.join('\n') + '\n';
  }

  // ============================ ZIP（store 无压缩，UTF-8 文件名） ============================
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  // files: [{name: string, data: Uint8Array}]
  function makeZip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dt = dosTime(now), dd = dosDate(now);

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);        // local header sig
      lh.setUint16(4, 20, true);                // version needed
      lh.setUint16(6, 0x0800, true);            // flags: UTF-8 names
      lh.setUint16(8, 0, true);                 // method: store
      lh.setUint16(10, dt, true);
      lh.setUint16(12, dd, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);             // compressed size
      lh.setUint32(22, size, true);             // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);                // extra len
      chunks.push(new Uint8Array(lh.buffer), nameBytes, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);        // central dir sig
      ch.setUint16(4, 20, true);                // version made by
      ch.setUint16(6, 20, true);                // version needed
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true);
      ch.setUint16(14, dd, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);                // extra
      ch.setUint16(32, 0, true);                // comment
      ch.setUint16(34, 0, true);                // disk
      ch.setUint16(36, 0, true);                // internal attrs
      ch.setUint32(38, 0, true);                // external attrs
      ch.setUint32(42, offset, true);           // local header offset
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
  }

  // ============================ 导出 ============================
  async function exportZip() {
    if (state.syncing) { log('同步进行中，请稍后再导出'); return; }
    await runSync();
    const nickname = state.nickname || 'User';
    const convs = [...state.convs.values()]
      .filter((c) => (state.msgs.get(c.id) || new Map()).size > 0)
      .sort((a, b) => a.create - b.create);
    if (!convs.length) { log('没有可导出的会话'); return; }

    const files = [];
    const used = new Set();
    let msgTotal = 0;
    for (const c of convs) {
      let dir = sanitize(c.name, '会话_' + c.id);
      let n = 2;
      while (used.has(dir)) dir = `${sanitize(c.name, '会话_' + c.id)}_${n++}`;
      used.add(dir);
      const msgs = [...state.msgs.get(c.id).values()];
      msgTotal += msgs.length;
      files.push({
        name: `${dir}/main.md`,
        data: buildMd(c, msgs, nickname)
      });
    }

    let blob, zipKind;
    if (typeof JSZip !== 'undefined') {
      // JSZip：DEFLATE 压缩 + UTF-8 文件名
      const zip = new JSZip();
      const folder = zip.folder('history');
      for (const f of files) folder.file(f.name, f.data);
      blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      zipKind = 'JSZip/deflate';
    } else {
      blob = makeZip(files.map((f) => ({ name: 'history/' + f.name, data: enc.encode(f.data) })));
      zipKind = 'store(回退)';
    }
    const ts = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const fname = `doubao-history-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.zip`;
    const kb = (blob.size / 1024).toFixed(0);
    // 生成完归档 → 自动挂链接并触发 blob 下载；链接常驻面板，可反复点击重新下载
    const dl = document.getElementById('dbb-dl');
    if (dl) {
      const url = URL.createObjectURL(blob);
      if (dl.__url) URL.revokeObjectURL(dl.__url);     // 回收上一次的 blob
      dl.__url = url;
      dl.href = url;
      dl.download = fname;
      dl.textContent = `⬇ ${fname} (${kb} KB，点击可重复下载)`;
      dl.style.display = 'block';
      dl.click();                                       // 自动生成即自动下载
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    }
    log(`已导出 ${fname}: ${files.length} 个会话 / ${msgTotal} 条消息 / ${kb} KB (${zipKind})`);
  }

  // ============================ UI ============================
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 面板下方的历史列表（按更新时间倒序，标出待抓取的会话）
  // 会话很多（3000+）时页面流量会频繁触发渲染，做 300ms 合并节流
  let renderTimer = null;
  function renderList() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderNow(); }, 300);
  }
  function renderNow() {
    const box = document.getElementById('dbb-list');
    const stats = document.getElementById('dbb-stats');
    if (!box) return;
    const convs = [...state.convs.values()].sort((a, b) => b.update - a.update);
    let totalMsgs = 0, pending = 0;
    box.innerHTML = convs.map((c) => {
      const n = (state.msgs.get(c.id) || new Map()).size;
      totalMsgs += n;
      const todo = needsSync(c);
      if (todo) pending++;
      const cls = todo ? 'dbb-item pending' : 'dbb-item';
      return `<div class="${cls}" title="ID: ${esc(c.id)}">
        <span class="dbb-name">${esc(c.name || '会话_' + c.id)}</span>
        <span class="dbb-meta">${n === 0 ? (todo ? '待抓' : '空') : n + ' 条'} · ${fmtDate(c.update)}</span>
      </div>`;
    }).join('') || '<div class="dbb-empty">暂无历史，等待首次同步…</div>';
    if (stats) {
      stats.textContent = `${convs.length} 会话 / ${totalMsgs} 消息` +
        (pending ? ` · ${pending} 待抓` : '') +
        ` · 列表已翻 ${state.listPages} 页(总数未知)`;
    }
  }

  function buildUi() {
    if (document.getElementById('dbb-panel')) return;
    GM_addStyle(`
      #dbb-panel{position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#1f2430;color:#e6e9f0;
        border:1px solid #3a4152;border-radius:10px;padding:10px 12px;font-size:12px;width:290px;
        box-shadow:0 6px 24px rgba(0,0,0,.35);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
      #dbb-panel .dbb-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:4px}
      #dbb-panel .dbb-head #dbb-status{font-weight:400;color:#8fd0ff;font-size:11px}
      #dbb-panel #dbb-stats{color:#9aa4b8;font-size:11px;margin-bottom:8px}
      #dbb-panel .dbb-btns{display:flex;gap:6px}
      #dbb-panel button{flex:1;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:6px 4px;
        font-size:12px;cursor:pointer}
      #dbb-panel button:hover{background:#4a84f5}
      #dbb-panel button:disabled{background:#555c6e;cursor:not-allowed}
      #dbb-panel #dbb-list{margin-top:8px;max-height:200px;overflow:auto;background:#171b26;
        border-radius:6px;padding:4px 0}
      #dbb-panel .dbb-item{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;
        border-bottom:1px solid #232838;align-items:center}
      #dbb-panel .dbb-item:last-child{border-bottom:0}
      #dbb-panel .dbb-item.pending .dbb-name{color:#ffb86b}
      #dbb-panel .dbb-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #dbb-panel .dbb-meta{color:#7f8aa3;font-size:10px;white-space:nowrap}
      #dbb-panel .dbb-empty{padding:8px;color:#7f8aa3;text-align:center}
      #dbb-panel a#dbb-dl{display:none;margin-top:6px;color:#8fd0ff;font-size:11px;text-decoration:none;
        word-break:break-all;background:#171b26;border-radius:6px;padding:5px 8px}
      #dbb-panel a#dbb-dl:hover{text-decoration:underline}
      #dbb-logbox{display:none;margin-top:8px;max-height:180px;overflow:auto;background:#141821;color:#a8d8a8;
        padding:6px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:10px;line-height:1.5}
    `);
    const panel = document.createElement('div');
    panel.id = 'dbb-panel';
    panel.innerHTML = `
      <div class="dbb-head"><span>豆包历史备份器</span><span id="dbb-status">待机</span></div>
      <div id="dbb-stats">尚未同步</div>
      <div class="dbb-btns">
        <button id="dbb-sync" title="立即拉取会话列表与全部消息">立即同步</button>
        <button id="dbb-export" title="同步后导出 history/<会话名>/main.md ZIP">导出归档</button>
        <button id="dbb-logbtn">日志</button>
      </div>
      <div id="dbb-list"><div class="dbb-empty">暂无历史，等待首次同步…</div></div>
      <a id="dbb-dl" title="再次点击重新下载上次归档"></a>
      <pre id="dbb-logbox"></pre>`;
    document.body.appendChild(panel);
    document.getElementById('dbb-sync').onclick = () => runSync();
    document.getElementById('dbb-export').onclick = () => exportZip().catch((e) => log('导出失败: ' + e.message));
    document.getElementById('dbb-logbtn').onclick = () => {
      const box = document.getElementById('dbb-logbox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      if (box.style.display === 'block') box.textContent = logs.join('\n');
    };
  }

  // ============================ 启动 ============================
  function boot() {
    buildUi();
    renderList();
    log('已启动：拦截历史 API + 每 60s 自动刷新（IndexedDB 缓存复用，只抓有变化的会话）');
    // 先从 IndexedDB 恢复上次的抓取进度，再做增量同步
    loadCache().catch(() => {}).then(() => {
      renderNow();
      setTimeout(() => runSync().catch(() => {}), 2000);
    });
    // 自动刷新：页面开着就持续轮询，只补抓新会话/有更新的会话
    setInterval(() => runSync().catch(() => {}), POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
