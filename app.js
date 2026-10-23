'use strict';
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

// ---------- 工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { draft: '草稿', open: '进行中', closed: '已结束' };
const SHOW_CN = { never: '不公开', after_close: '结束后公开', always: '实时公开' };
const badge = s => `<span class="badge ${s}">${STATUS[s]}</span>`;
const pad = n => String(n).padStart(2, '0');
const fmt = t => { if (!t) return '—'; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtFull = t => t ? fmt(t) + ':' + pad(new Date(t).getSeconds()) : '';
const toLocalInput = t => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const pct = x => (Math.round(x * 1000) / 10) + '%';

function toast(msg, err) {
  const el = document.createElement('div');
  el.textContent = msg; if (err) el.className = 'err';
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// 管理员令牌、投票者标识都存在 localStorage（站点与云函数跨域，不能用 Cookie）
const auth = {
  get token() { return localStorage.getItem('vv_admin_token') || ''; },
  set token(v) { v ? localStorage.setItem('vv_admin_token', v) : localStorage.removeItem('vv_admin_token'); },
  get voter() {
    let v = localStorage.getItem('vv_voter');
    if (!/^[a-f0-9]{32}$/.test(v || '')) {
      v = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('vv_voter', v);
    }
    return v;
  },
};
// 设备特征码：只取同一台设备上各浏览器/无痕模式基本一致的特征（屏幕、显卡、画布渲染、时区等），不含浏览器 UA
let fpCache;
async function deviceFp() {
  if (fpCache) return fpCache;
  const parts = [screen.width + 'x' + screen.height + 'x' + screen.colorDepth, devicePixelRatio, navigator.maxTouchPoints, navigator.hardwareConcurrency,
    (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone];
  try {
    const c = document.createElement('canvas'); c.width = 260; c.height = 60;
    const g = c.getContext('2d');
    g.textBaseline = 'top'; g.font = '16px Arial'; g.fillStyle = '#f60'; g.fillRect(110, 1, 62, 20);
    g.fillStyle = '#069'; g.fillText('排球 Volleyball 2026 ✓', 2, 15);
    g.fillStyle = 'rgba(102,204,0,.7)'; g.fillText('排球 Volleyball 2026 ✓', 4, 17);
    parts.push(c.toDataURL());
  } catch (e) { }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    parts.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch (e) { }
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('||')));
    fpCache = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch (e) { fpCache = ''; }
  return fpCache;
}
// 按设备键分组：同组第 2 张起标为疑似重复（选票需按时间升序）
function markDuplicates(ballots) {
  const groups = new Map();
  for (const b of ballots) if (b.devKey) { if (!groups.has(b.devKey)) groups.set(b.devKey, []); groups.get(b.devKey).push(b); }
  let g = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    g++;
    list.forEach((b, i) => { b.group = g; b.dup = i > 0; });
  }
  return ballots.filter(b => b.dup).length;
}
async function api(action, params = {}) {
  let res;
  try {
    res = await fetch(window.VV_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, token: auth.token, ...params }) });
  } catch (e) { throw new Error('网络连接失败，请检查网络后重试'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && action.startsWith('admin.')) { auth.token = ''; if (location.hash.startsWith('#/admin')) setTimeout(router); }
  if (!res.ok) { const e = new Error(data.error || `请求失败 (${res.status})`); e.status = res.status; throw e; }
  return data;
}
function modal(html, onMount, wide) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal card pad" ${wide ? 'style="width:min(820px,100%)"' : ''}>${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  onMount && onMount(bg.querySelector('.modal'), close);
  return close;
}
function confirmBox(title, text, okText = '确定', danger) {
  return new Promise(resolve => {
    modal(`<h2>${esc(title)}</h2><p class="sub">${text}</p><div class="row" style="justify-content:flex-end;margin-top:24px">
      <button class="btn" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okText)}</button></div>`,
      (m, close) => { m.querySelector('#ok').onclick = () => { close(); resolve(true); }; m.querySelector('[data-close]').addEventListener('click', () => resolve(false)); });
  });
}
// 同时只播放一个视频
document.addEventListener('play', e => { document.querySelectorAll('video').forEach(v => { if (v !== e.target) v.pause(); }); }, true);

// ---------- 背景音乐（仅投票页）：循环；看视频时暂停、看完接着放；手动关闭后永久不再响（记在本机） ----------
const bgm = (() => {
  const KEY = 'vv_bgm_off';
  let audio = null, active = false, waiting = false;
  const off = () => localStorage.getItem(KEY) === '1';
  const videoPlaying = () => [...document.querySelectorAll('video')].some(v => !v.paused && !v.ended);
  const btn = () => document.getElementById('bgmbtn');
  const paint = () => {
    const b = btn(); if (!b) return;
    const on = audio && !audio.paused;
    b.classList.toggle('on', !!on);
    b.classList.toggle('muted', off());
    b.title = off() ? '背景音乐已关闭，点击打开' : on ? '点击关闭背景音乐' : '点击播放背景音乐';
  };
  const play = () => {
    if (!active || off() || videoPlaying()) return paint();
    if (!audio) { audio = new Audio('bgm.mp3'); audio.loop = true; audio.volume = 0.45; audio.onplay = audio.onpause = paint; }
    audio.play().catch(waitForGesture);
  };
  // 浏览器不许一进页面就出声：等用户第一次点击/滑动屏幕再开始
  const gesture = e => {
    if (e.target.closest && e.target.closest('#bgmbtn')) return; // 点开关本身交给开关处理
    stopWaiting(); play();
  };
  const stopWaiting = () => { waiting = false; ['pointerdown', 'touchstart', 'keydown'].forEach(t => document.removeEventListener(t, gesture, true)); };
  const waitForGesture = () => { if (waiting) return; waiting = true; ['pointerdown', 'touchstart', 'keydown'].forEach(t => document.addEventListener(t, gesture, true)); paint(); };
  // 看视频时暂停，视频暂停/播完后接着放
  document.addEventListener('play', e => { if (e.target.tagName === 'VIDEO' && audio) audio.pause(); }, true);
  ['pause', 'ended'].forEach(t => document.addEventListener(t, e => { if (e.target.tagName === 'VIDEO') setTimeout(play, 300); }, true));
  return {
    start() {
      active = true;
      $nav.innerHTML = '<button id="bgmbtn" class="bgm-btn" aria-label="背景音乐开关"><span>♪</span></button>';
      btn().onclick = () => {
        if (off()) { localStorage.removeItem(KEY); stopWaiting(); play(); }
        else if (audio && !audio.paused) { localStorage.setItem(KEY, '1'); audio.pause(); }
        else { stopWaiting(); play(); }
        paint();
      };
      play();
      // 微信内置浏览器：借 WeixinJSBridge 实现进页面即自动播放
      const wx = () => window.WeixinJSBridge.invoke('getNetworkType', {}, play);
      if (window.WeixinJSBridge) wx(); else document.addEventListener('WeixinJSBridgeReady', wx, { once: true });
    },
    stop() { active = false; stopWaiting(); if (audio) audio.pause(); },
  };
})();

// 单序列横向条形图：单色、细条、圆角数据端、悬停提示
let $tip;
function barChart(rows, total) {
  const max = Math.max(1, ...rows.map(r => r.votes));
  return `<div class="bars">${rows.map(r => `
    <div class="bar-row" data-tip="${esc(`V${r.no} ${esc(r.title)}<br>得票 ${r.votes} · 占投票人数 ${pct(r.pct)}`)}">
      <div class="rank ${r.rank <= 3 && r.votes ? 'top' : ''}">#${r.rank}</div>
      <div class="name" title="${esc(r.title)}">V${r.no} · ${esc(r.title)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(r.votes / max) * 100}%"></div></div>
      <div class="val"><b>${r.votes}</b><small>${total ? pct(r.pct) : ''}</small></div>
    </div>`).join('')}</div>`;
}
document.addEventListener('mousemove', e => {
  const row = e.target.closest && e.target.closest('[data-tip]');
  if (!$tip) { $tip = document.createElement('div'); $tip.className = 'tip'; document.body.appendChild($tip); }
  if (!row) { $tip.style.display = 'none'; return; }
  $tip.innerHTML = row.dataset.tip; $tip.style.display = 'block';
  $tip.style.left = Math.min(e.clientX + 14, innerWidth - $tip.offsetWidth - 10) + 'px';
  $tip.style.top = (e.clientY + 16) + 'px';
});

// 由选票明细计算排行（管理端以明细为准）
function tallyBallots(poll, ballots) {
  const counts = new Map(poll.videos.map(v => [v.id, 0]));
  for (const b of ballots) for (const c of b.choices) if (counts.has(c)) counts.set(c, counts.get(c) + 1);
  const total = ballots.length;
  const rows = poll.videos.map((v, i) => ({ id: v.id, no: i + 1, title: v.title, from: v.from, votes: counts.get(v.id), pct: total ? counts.get(v.id) / total : 0 }));
  rows.sort((a, b) => b.votes - a.votes || a.no - b.no);
  rows.forEach((r, i) => { r.rank = i > 0 && r.votes === rows[i - 1].votes ? rows[i - 1].rank : i + 1; });
  return { total, rows };
}

// 统计口径：all = 全部选票；cutoff = 只算第一截止时间之前投出的选票
const inScope = (poll, scope) => b => scope !== 'cutoff' || !poll.cutoff || b.createdAt <= poll.cutoff;
const scopeLabel = (poll, scope) => scope === 'cutoff' && poll.cutoff ? `截至第一截止 ${fmt(poll.cutoff)}` : '全部选票';

// ---------- 导出（浏览器端生成 xlsx / csv / json） ----------
function exportTables(poll, allBallots, scope) {
  markDuplicates(allBallots);
  const ballots = allBallots.filter(inScope(poll, scope));
  const { total, rows } = tallyBallots(poll, ballots);
  const dupCount = ballots.filter(b => b.dup).length;
  const label = (v, i) => `V${i + 1} ${v.title}`;
  const vlabel = new Map(poll.videos.map((v, i) => [v.id, label(v, i)]));
  const info = [['项目', '内容'], ['投票标题', poll.title], ['投票说明', poll.description || ''], ['状态', STATUS[poll.status]],
    ['视频数量', poll.videos.length], ['每人最多可选', poll.maxChoices], ['每人最少需选', poll.minChoices], ['需要实名', poll.requireName ? '是' : '否'],
    ['随机顺序', poll.shuffle ? '是' : '否'], ['结果公开方式', SHOW_CN[poll.showResults]], ['创建时间', fmtFull(poll.createdAt)], ['开始时间', fmtFull(poll.openedAt)],
    ['结束时间', fmtFull(poll.closedAt)], ['第一截止（评选统计）', fmtFull(poll.cutoff)], ['第一截止说明', poll.cutoffNote || ''], ['结束投票时间（不对投票者显示）', fmtFull(poll.deadline)],
    ['本表统计范围', scopeLabel(poll, scope) + (scope === 'cutoff' && poll.cutoff ? '（之后投出的选票不计入）' : '')], ['总投票人数', total], ['总选票数', ballots.reduce((s, b) => s + b.choices.length, 0)], ['疑似重复选票数', dupCount], ['说明', '疑似重复=与更早的选票设备特征和网络相同；同型号手机在同一网络下可能误判，统计已包含这些选票'], ['导出时间', fmtFull(Date.now())]];
  const summary = [['排名', '视频编号', '视频标题', '来源', '得票数', '得票率(占投票人数)']]
    .concat(rows.map(r => [r.rank, `V${r.no}`, r.title, r.from || '', r.votes, total ? Math.round(r.pct * 10000) / 100 + '%' : '0%']));
  const detail = [['序号', '投票人', '投票时间', 'IP', '设备组', '疑似重复', '选择数', '所选视频', ...poll.videos.map(label)]]
    .concat(ballots.map((b, i) => {
      const set = new Set(b.choices);
      return [i + 1, b.voterName || '(匿名)', fmtFull(b.createdAt), b.ip || '', b.group || '', b.dup ? '是' : '', b.choices.length, b.choices.map(c => vlabel.get(c) || c).join('；'), ...poll.videos.map(v => set.has(v.id) ? 1 : 0)];
    }));
  return { info, summary, detail };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStore(files) { // 不压缩的 zip（store），足够小且无需依赖
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true));
    const ch = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [42, off, 4]]
      .forEach(([o, v, s]) => s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true));
    parts.push(lh, name, data); central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function sheetXml(rows) {
  const ncol = Math.max(...rows.map(r => r.length));
  const widths = Array.from({ length: ncol }, (_, c) => Math.min(60, Math.max(8, ...rows.map(r => { let w = 0; for (const ch of String(r[c] ?? '')) w += ch.charCodeAt(0) > 255 ? 2 : 1; return w + 2; }))));
  const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
    const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
    return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v ?? '')}</t></is></c>`;
  }).join('') + '</row>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${body}</sheetData></worksheet>`;
}
function buildXlsx(sheets) {
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    { name: '[Content_Types].xml', data: `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `${X}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ]);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// 二维码海报（宣传横幅 + 标题 + 二维码 + 规则），与 tools/make_qr.py 同版式
const loadScript = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('二维码组件加载失败')); document.head.appendChild(s); });
const loadImage = src => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('宣传图加载失败')); i.src = src; });
async function qrPoster(poll, link) {
  if (!window.qrcode) await loadScript('vendor/qrcode.js');
  const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
  const banner = await loadImage('banner.jpg');
  const W = 1080, bh = Math.round(banner.height * W / banner.width), qs = 620, font = '"Microsoft YaHei","PingFang SC",sans-serif';
  const lines = [poll.minChoices === poll.maxChoices ? `请选出 ${poll.maxChoices} 个最喜欢的视频` : `每人最多选 ${poll.maxChoices} 个最喜欢的视频`];
  if (poll.cutoff) { const d = new Date(poll.cutoff); lines.push(`${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} 评选截止${poll.cutoffNote ? ' · ' + poll.cutoffNote : ''}`); }
  const c = document.createElement('canvas'); c.width = W; c.height = bh + 1080;
  const g = c.getContext('2d');
  g.fillStyle = '#f6f7fb'; g.fillRect(0, 0, W, c.height);
  g.drawImage(banner, 0, 0, W, bh);
  g.textAlign = 'center'; g.textBaseline = 'top';
  let y = bh + 60;
  g.fillStyle = '#161a2e'; g.font = `bold 58px ${font}`; g.fillText(poll.title, W / 2, y, W - 80);
  y += 130;
  const pad0 = 36, x0 = (W - qs) / 2;
  g.fillStyle = '#fff'; g.strokeStyle = '#e2e6f0'; g.lineWidth = 2;
  g.beginPath(); g.roundRect(x0 - pad0, y - pad0, qs + pad0 * 2, qs + pad0 * 2, 36); g.fill(); g.stroke();
  const n = qr.getModuleCount(), cell = qs / (n + 4);
  g.fillStyle = '#161a2e';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) g.fillRect(Math.floor(x0 + (col + 2) * cell), Math.floor(y + (r + 2) * cell), Math.ceil(cell), Math.ceil(cell));
  y += qs + pad0 + 50;
  g.fillStyle = '#1f5fd6'; g.font = `bold 44px ${font}`; g.fillText('微信或手机相机扫码参与投票', W / 2, y);
  y += 80;
  g.fillStyle = '#6e748c'; g.font = `32px ${font}`;
  for (const l of lines) { g.fillText(l, W / 2, y, W - 80); y += 52; }
  return await new Promise(ok => c.toBlob(ok, 'image/png'));
}
async function exportPoll(id, format, scope) {
  const { poll, ballots: all } = await api('admin.ballots', { id });
  const stamp = fmtFull(Date.now()).replace(/[-: ]/g, '').slice(0, 12);
  const base = `投票数据_${poll.title}${scope === 'cutoff' && poll.cutoff ? '_截至第一截止' : ''}_${stamp}`.replace(/[\\/:*?"<>|]/g, '_');
  const t = exportTables(poll, all, scope);
  const ballots = all.filter(inScope(poll, scope));
  if (format === 'json') {
    download(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), scope: scopeLabel(poll, scope), poll, results: tallyBallots(poll, ballots), ballots }, null, 2)], { type: 'application/json' }), base + '.json');
  } else if (format === 'csv') {
    const cell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    download(new Blob(['﻿' + t.detail.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), base + '_明细.csv');
  } else {
    download(buildXlsx([{ name: '得票汇总', rows: t.summary }, { name: '投票明细', rows: t.detail }, { name: '投票信息', rows: t.info }]), base + '.xlsx');
  }
}

// ---------- 路由 ----------
let timer = null;
const stopTimer = () => { clearInterval(timer); timer = null; };
async function router() {
  stopTimer();
  if ($tip) $tip.style.display = 'none';
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'p' && parts[1]) { bgm.start(); return await votePage(parts[1]); }
    bgm.stop();
    const admin = !!auth.token;
    $nav.innerHTML = admin ? `<a class="btn ghost sm" href="#/admin">我的投票</a><button class="btn ghost sm" id="logout">退出</button>` : '';
    if (admin) document.getElementById('logout').onclick = () => { auth.token = ''; location.hash = '#/'; router(); };
    if (parts[0] === 'admin') {
      if (!admin) return loginPage();
      return parts[1] ? await pollPage(parts[1]) : await dashboard();
    }
    await homePage(admin);
  } catch (e) {
    $app.innerHTML = `<div class="card empty"><div class="big">😕</div>${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', router);

const BANNER = '<img class="banner" src="banner.jpg" alt="北京信息科技大学2026年“排绽风采，聚力同行”教职工气排球团体赛">';
async function homePage(admin) {
  const adminLink = admin ? '<a class="btn primary" href="#/admin">进入管理后台 →</a>' : '<a class="muted" href="#/admin">管理员登录</a>';
  $app.innerHTML = `${BANNER}<div class="card empty">加载中…</div>`;
  let polls = [];
  try { polls = await api('list'); } catch (e) { $app.innerHTML = `${BANNER}<div class="card empty">${esc(e.message)}</div>`; return; }
  $app.innerHTML = `${BANNER}<div class="home-list">
  <h2 style="margin:4px 0 14px">🏐 精彩视频评选</h2>
  ${polls.length ? `<div class="poll-list">${polls.map(p => `
    <a class="card poll-item home-poll" href="#/p/${p.id}">
      ${p.cover ? `<img class="home-cover" src="${esc(p.cover)}" alt="" loading="lazy">` : ''}
      <div class="spread">${badge(p.status)}<span class="muted">${p.videoCount} 个视频</span></div>
      <h3>${esc(p.title)}</h3>
      <span class="btn ${p.status === 'open' ? 'primary' : ''}" style="align-self:flex-start">${p.status === 'open' ? '去投票 →' : '查看 →'}</span>
    </a>`).join('')}</div>`
    : `<div class="card empty"><div class="big">🗳️</div><p>评选还没开始，比赛期间每天晚上会发布当天的精彩视频评选，敬请期待。</p></div>`}
  <div style="text-align:center;margin:28px 0 8px">${adminLink}</div></div>`;
}

function loginPage() {
  $app.innerHTML = `<div class="login card pad stack">
    <div><h1>管理员登录</h1></div>
    <form id="f" class="stack"><div class="field"><label>管理员密码</label><input class="input" type="password" name="pw" autofocus required></div>
    <button class="btn primary lg" style="width:100%">登录</button></form></div>`;
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try { auth.token = (await api('login', { password: e.target.pw.value.trim() })).token; router(); }
    catch (err) { toast(err.message, true); btn.disabled = false; }
  };
}

// ---------- 管理后台：列表 ----------
async function dashboard() {
  const polls = await api('admin.list');
  $app.innerHTML = `<div class="spread" style="margin-bottom:24px"><div><h1>我的投票</h1><p class="muted">共 ${polls.length} 个投票</p></div>
    <div class="row"><button class="btn" id="speed">📶 上传测速</button><button class="btn primary" id="new">＋ 新建投票</button></div></div>
    ${polls.length ? `<div class="poll-list">${polls.map(p => `
      <div class="card poll-item" data-id="${p.id}">
        <div class="spread">${badge(p.status)}<span class="muted">${fmt(p.createdAt)}</span></div>
        <h3>${esc(p.title)}</h3>
        <div class="stats">
          <div class="stat"><b>${p.videos.length}</b><span>视频</span></div>
          <div class="stat"><b>${p.maxChoices}</b><span>每人可选</span></div>
          <div class="stat"><b>${p.ballotCount || 0}</b><span>已投人数</span></div>
        </div>
      </div>`).join('')}</div>`
      : `<div class="card empty"><div class="big">🗳️</div><p>还没有投票，点击右上角新建一个吧</p></div>`}`;
  document.getElementById('new').onclick = newPollModal;
  document.getElementById('speed').onclick = speedModal;
  $app.querySelectorAll('.poll-item').forEach(el => el.onclick = () => location.hash = `#/admin/${el.dataset.id}`);
}

const stepper = (name, val, min, max, dis) => `<div class="stepper"><button type="button" data-step="-1" ${dis}>−</button><input name="${name}" type="number" min="${min}" max="${max}" value="${val}" ${dis}><button type="button" data-step="1" ${dis}>＋</button></div>`;
function settingsForm(p, locked) {
  const dis = locked ? 'disabled' : '';
  return `
    <div class="field"><label>投票标题 *</label><input class="input" name="title" value="${esc(p.title)}" maxlength="100" required placeholder="例如：11月3日 精彩瞬间评选"></div>
    <div class="field"><label>投票说明</label><textarea class="input" name="description" maxlength="2000" placeholder="介绍评选规则等（选填）">${esc(p.description)}</textarea></div>
    <div class="grid2">
      <div class="field"><label>每人最多选择</label>${stepper('maxChoices', p.maxChoices, 1, 100, dis)}<span class="hint">选出最喜欢的几个</span></div>
      <div class="field"><label>每人最少选择</label>${stepper('minChoices', p.minChoices, 1, 100, dis)}<span class="hint">与最多相同则必须选满</span></div>
    </div>
    <div class="grid2">
      <div class="field"><label>第一截止：评选统计时间（选填）</label><input class="input" type="datetime-local" name="cutoff" value="${toLocalInput(p.cutoff)}"><span class="hint">投票页会显示；到点后投票不停，后台可导出“截至此时”的数据</span></div>
      <div class="field"><label>第一截止的说明（投票页显示）</label><input class="input" name="cutoffNote" maxlength="100" value="${esc(p.cutoffNote ?? '')}" placeholder="例如：届时将选出当日最佳视频"></div>
      <div class="field"><label>第二截止：结束投票时间（选填）</label><input class="input" type="datetime-local" name="deadline" value="${toLocalInput(p.deadline)}"><span class="hint">🙈 不在投票页显示；到点自动关闭投票</span></div>
    </div>
    <div class="grid2">
      <label class="switch"><input type="checkbox" name="requireName" ${p.requireName ? 'checked' : ''} ${dis}><span class="track"></span>投票需填写姓名（同名只能投一次）</label>
      <label class="switch"><input type="checkbox" name="shuffle" ${p.shuffle ? 'checked' : ''} ${dis}><span class="track"></span>每位投票者看到随机顺序</label>
    </div>
    <div class="field"><label>投票者能否看到结果</label><select class="input" name="showResults">
      ${[['after_close', '投票结束后公开'], ['always', '投票后实时可见'], ['never', '不公开（仅管理员可见）']].map(([v, t]) => `<option value="${v}" ${p.showResults === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select></div>
    ${locked ? '<p class="muted">🔒 投票已发布，选择规则已锁定以保证公平；标题、说明、截止时间、结果公开方式仍可修改。</p>' : ''}`;
}
function bindSteppers(root) {
  root.querySelectorAll('.stepper').forEach(s => {
    const input = s.querySelector('input');
    s.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { input.value = Math.min(+input.max, Math.max(+input.min, (+input.value || 0) + +b.dataset.step)); });
  });
}
const readForm = f => ({
  title: f.title.value, description: f.description.value, maxChoices: +f.maxChoices.value, minChoices: +f.minChoices.value,
  requireName: f.requireName.checked, shuffle: f.shuffle.checked, showResults: f.showResults.value,
  deadline: f.deadline.value ? new Date(f.deadline.value).toISOString() : null,
  cutoff: f.cutoff.value ? new Date(f.cutoff.value).toISOString() : null,
  cutoffNote: f.cutoffNote.value,
});

// 测这台电脑在当前网络下往 GitHub 上传的速度，判断能否在网页里上传视频
function speedModal() {
  modal(`<h2>📶 上传测速</h2><p class="sub">测试这台电脑在当前网络下往 GitHub 上传视频的速度（会上传 1 MB 随机数据，不影响网站）。约需几秒到一分钟。</p>
    <div id="spres" class="notice" style="margin-top:16px">测试中…</div>
    <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn" data-close>关闭</button></div>`, async m => {
    const out = m.querySelector('#spres');
    const say = html => { if (document.body.contains(out)) out.innerHTML = html; };
    try {
      const up = await import('./uploader.js');
      const enc = up.supported();
      const cfg = await api('admin.ghConfig');
      const r = await up.speedTest(cfg, 1);
      // GitHub 单个请求约 60 秒上限，留余量按 45 秒算；视频按 base64 后体积 ×1.37
      const maxMB = r.kbps * 45 / 1024 / 1.37;
      const t10 = 10 * 1.37 * 1024 / r.kbps;
      const level = maxMB >= 30 ? ['✅ 很好', '可以放心在网页里上传'] : maxMB >= 10 ? ['🙂 可用', '一般的精彩片段（1 分钟内）没问题，很长的视频可能失败'] : ['❌ 太慢', '不建议在这台电脑/这个网络下网页上传，请换网络，或用原电脑的脚本'];
      say(`<b>${level[0]}</b>：上传速度约 <b>${r.kbps >= 1024 ? (r.kbps / 1024).toFixed(1) + ' MB/s' : Math.round(r.kbps) + ' KB/s'}</b><br>
        压缩后一个 10 MB 的视频约需 <b>${t10 < 60 ? Math.ceil(t10) + ' 秒' : (t10 / 60).toFixed(1) + ' 分钟'}</b>；单个视频压缩后最大约可传 <b>${maxMB >= 100 ? '90' : maxMB.toFixed(1)} MB</b>（约 1 分钟 720p 视频为 5–10 MB）<br>
        ${level[1]}。<br>${enc ? '✅ 这个浏览器支持网页内压缩视频' : '❌ 这个浏览器不支持网页内压缩视频，请用电脑上最新版 Chrome 或 Edge'}`);
    } catch (e) { say('❌ 测速失败：' + esc(e.message)); }
  });
}

function newPollModal() {
  const p = { title: '', description: '', maxChoices: 3, minChoices: 1, requireName: false, shuffle: true, showResults: 'after_close', deadline: null, cutoff: null, cutoffNote: '届时将选出当日最佳视频' };
  modal(`<h2>新建投票</h2><form id="nf" class="stack">${settingsForm(p)}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>取消</button><button class="btn primary">创建</button></div></form>`,
    (m, close) => {
      bindSteppers(m);
      const f = m.querySelector('#nf');
      f.onsubmit = async e => {
        e.preventDefault();
        try { const poll = await api('admin.create', readForm(f)); close(); location.hash = `#/admin/${poll.id}`; }
        catch (err) { toast(err.message, true); }
      };
    });
}

// ---------- 管理后台：投票详情 ----------
let currentTab = 'setup', lastPollId = null, scope = 'all';

async function pollPage(id) {
  let poll = await api('admin.get', { id });
  if (lastPollId !== id) {
    currentTab = poll.status !== 'draft' && poll.ballotCount ? 'results' : 'setup';
    scope = poll.cutoff && Date.now() > Date.parse(poll.cutoff) ? 'cutoff' : 'all';
  }
  lastPollId = id;
  const link = `${location.origin}${location.pathname}#/p/${poll.id}`;

  const renderHead = () => {
    const n = poll.videos.length;
    document.getElementById('head').innerHTML = `
      <a href="#/admin" class="muted">← 返回列表</a>
      <div class="spread" style="margin-top:10px">
        <div><div class="row">${badge(poll.status)}<span class="muted">创建于 ${fmt(poll.createdAt)}${poll.cutoff ? ` · 第一截止 ${fmt(poll.cutoff)}` : ''}${poll.deadline ? ` · 结束投票 ${fmt(poll.deadline)}` : ''}</span></div>
          <h1 style="margin-top:8px">${esc(poll.title)}</h1></div>
        <div class="row">
          ${poll.status === 'draft' ? `<button class="btn primary" id="publish" ${n < 2 ? 'disabled' : ''}>🚀 发布投票</button>` : ''}
          ${poll.status === 'open' ? `<button class="btn" id="close">⏹ 结束投票</button>` : ''}
          ${poll.status === 'closed' ? `<button class="btn" id="reopen">↻ 重新开启</button>` : ''}
          ${poll.status !== 'draft' && !poll.ballotCount ? `<button class="btn ghost" id="todraft">退回草稿</button>` : ''}
          <button class="btn danger" id="del">删除</button>
        </div>
      </div>
      ${poll.status !== 'draft' ? `<div class="share" style="margin-top:18px"><span>🔗 投票链接</span><code>${esc(link)}</code>
        <button class="btn sm" id="copy">复制</button><button class="btn sm" id="qrbtn">🔳 二维码海报</button><a class="btn sm" href="${esc(link)}" target="_blank">打开</a></div>`
        : `<p class="muted" style="margin-top:14px">${n < 2 ? '📌 至少需要 2 个视频才能发布。' : `✅ 已有 ${n} 个视频，确认规则后即可发布。`}</p>`}`;
    const on = (sel, fn) => { const el = document.getElementById(sel); if (el) el.onclick = fn; };
    const setStatus = async status => { try { poll = await api('admin.status', { id, status }); renderAll(); toast('已更新'); } catch (e) { toast(e.message, true); } };
    on('publish', async () => { if (await confirmBox('发布投票', `共 ${n} 个视频，每人最多选 ${poll.maxChoices} 个、最少 ${poll.minChoices} 个。<br>第一截止（评选统计）：${poll.cutoff ? fmt(poll.cutoff) + (poll.cutoffNote ? `，“${esc(poll.cutoffNote)}”` : '') : '未设置'}<br>结束投票：${poll.deadline ? fmt(poll.deadline) + '（不对投票者显示）' : '未设置，需手动结束'}<br>⚠️ 如果有其他管理员在一起上传，请先确认大家都已上传完成。<br>发布后视频与选择规则将锁定，不能再添加视频。确定发布吗？`, '发布')) setStatus('open'); });
    on('close', async () => { if (await confirmBox('结束投票', '结束后投票者将无法继续投票，之后仍可重新开启。', '结束投票')) setStatus('closed'); });
    on('reopen', () => setStatus('open'));
    on('todraft', () => setStatus('draft'));
    on('copy', () => { navigator.clipboard.writeText(link).then(() => toast('链接已复制'), () => toast('复制失败，请手动复制', true)); });
    on('qrbtn', async () => {
      try {
        const blob = await qrPoster(poll, link);
        const url = URL.createObjectURL(blob), name = `投票二维码_${poll.title}.png`.replace(/[\\/:*?"<>|]/g, '_');
        modal(`<h2>二维码海报</h2><img src="${url}" style="width:100%;max-height:62vh;object-fit:contain;border-radius:12px;border:1px solid var(--line)">
          <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-close>关闭</button><button class="btn primary" id="dlqr">下载图片</button></div>`,
          m => { m.querySelector('#dlqr').onclick = () => download(blob, name); });
      } catch (e) { toast('生成失败：' + e.message, true); }
    });
    on('del', async () => {
      if (!await confirmBox('删除投票', `将永久删除「${esc(poll.title)}」及其 ${poll.ballotCount || 0} 条投票记录，不可恢复。建议先导出数据。<br><span class="muted">（视频文件本身不会被删除）</span>`, '永久删除', true)) return;
      await api('admin.delete', { id }); toast('已删除'); location.hash = '#/admin';
    });
  };

  const renderTabs = () => {
    document.getElementById('tabs').innerHTML = [['setup', '设置与视频'], ['results', '统计结果'], ['ballots', `投票记录 (${poll.ballotCount || 0})`]]
      .map(([k, t]) => `<button class="${currentTab === k ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('');
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { currentTab = b.dataset.tab; renderAll(); });
  };
  const renderAll = () => { stopTimer(); renderHead(); renderTabs(); currentTab === 'setup' ? renderSetup() : renderData(); };

  // ----- 设置与视频 -----
  const saveVideos = async videos => {
    try { poll = await api('admin.setVideos', { id, videos, rev: poll.rev || 0 }); renderHead(); renderVideos(); return true; }
    catch (e) {
      toast(e.message, true);
      if (e.status === 409) { try { poll = await api('admin.get', { id }); renderHead(); } catch (_) { } }
      renderVideos(); return false;
    }
  };
  // 多名管理员同时编辑草稿：每 20 秒检查一次，别人上传/改动后自动刷新视频列表（正在改标题时不打断）
  const watchDraft = () => {
    if (poll.status !== 'draft' || timer) return;
    timer = setInterval(async () => {
      if (document.hidden || currentTab !== 'setup' || location.hash !== `#/admin/${id}` || document.querySelector('.modal-bg')) return;
      if (document.activeElement && document.activeElement.classList.contains('title-input')) return;
      try {
        const fresh = await api('admin.get', { id });
        if ((fresh.rev || 0) !== (poll.rev || 0) || fresh.status !== poll.status) {
          const n = fresh.videos.length - poll.videos.length;
          poll = fresh; renderHead(); renderVideos();
          if (n > 0) toast(`其他管理员新加了 ${n} 个视频`);
        }
      } catch (_) { }
    }, 20000);
  };
  const renderSetup = () => {
    const locked = poll.status !== 'draft';
    document.getElementById('body').innerHTML = `
      <div class="card pad"><div class="spread"><h2>候选视频 <span class="muted" id="vcount">${poll.videos.length} 个</span></h2>
        ${!locked ? `<button class="btn sm" id="import">📂 从往期投票导入</button>` : ''}</div>
        ${!locked ? `<div class="slot" id="drop" style="aspect-ratio:auto;padding:26px;margin-bottom:16px"><div class="plus">＋</div><b>把视频拖到这里，或点击选择（可多选）</b>
          <div class="muted">文件名就是视频标题（开头的序号会自动去掉）。视频会在这台电脑的浏览器里压缩成 720p 再上传，期间请不要关闭页面。<br>总评投票可点右上角「从往期投票导入」挑选前几天的视频。</div></div>
          <div id="uplist" class="stack" style="margin-bottom:16px"></div><input type="file" id="vfile" accept="video/*,.mov,.mkv" multiple hidden>` : ''}
        <div class="video-grid" id="vgrid"></div></div>
      <div class="card pad"><h2>投票设置</h2><form id="sf" class="stack">${settingsForm(poll, locked)}
        <div class="row" style="justify-content:flex-end"><button class="btn primary">保存设置</button></div></form></div>`;
    renderVideos();
    watchDraft();
    const f = document.getElementById('sf');
    bindSteppers(f);
    f.onsubmit = async e => {
      e.preventDefault();
      try { poll = await api('admin.update', { id, ...readForm(f) }); toast('设置已保存'); renderAll(); }
      catch (err) { toast(err.message, true); }
    };
    const imp = document.getElementById('import');
    if (imp) imp.onclick = importModal;
    const drop = document.getElementById('drop'), vfile = document.getElementById('vfile');
    if (drop) {
      drop.onclick = () => { if (!uploading) vfile.click(); };
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('drag'); };
      drop.ondragleave = () => drop.classList.remove('drag');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('drag'); uploadVideos([...e.dataTransfer.files]); };
      vfile.onchange = () => { uploadVideos([...vfile.files]); vfile.value = ''; };
      renderUploads();
    }
  };

  // ----- 网页上传：浏览器内压缩 → 一次提交到 GitHub → 挂到投票 -----
  let uploading = false, upItems = [];
  const titleOf = name => { const t = name.replace(/\.[^.]+$/, ''); return t.replace(/^\d+[\s._、-]+/, '').trim() || t; };
  const renderUploads = () => {
    const box = document.getElementById('uplist');
    if (!box) return;
    box.innerHTML = upItems.map(u => `<div class="row" style="gap:12px;flex-wrap:nowrap">
      <span style="flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.file.name)}">${esc(u.file.name)}</span>
      <div class="progress" style="flex:1;width:auto"><i style="width:${u.pct}%;${u.error ? 'background:var(--bad)' : ''}"></i></div>
      <span class="muted" style="flex:0 0 30%;font-size:13px;color:${u.error ? 'var(--bad)' : ''}">${esc(u.status)}</span></div>`).join('');
  };
  const setItem = (u, status, pct) => { u.status = status; if (pct != null) u.pct = pct; renderUploads(); };
  const uploadVideos = async picked => {
    if (uploading) return toast('正在上传，请等这一批完成', true);
    const vids = picked.filter(f => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name));
    if (!vids.length) return toast('没有找到视频文件', true);
    if (vids.length < picked.length) toast('已忽略非视频文件', true);
    let up;
    try {
      up = await import('./uploader.js');
      if (!up.supported()) throw new Error('这个浏览器不支持网页内压缩视频，请用电脑上最新版的 Chrome 或 Edge');
    } catch (e) { return toast(e.message.includes('uploader') ? '上传组件加载失败，请刷新重试' : e.message, true); }
    let cfg;
    try { cfg = await api('admin.ghConfig'); } catch (e) { return toast(e.message, true); }

    uploading = true;
    window.onbeforeunload = () => '视频正在上传，离开会中断';
    upItems = vids.map(file => ({ file, status: '等待压缩', pct: 0 }));
    renderUploads();
    const stamp = Date.now().toString(36);
    const files = [], added = [];
    for (const [k, u] of upItems.entries()) {
      try {
        setItem(u, '压缩中 0%', 0);
        const { blob, noAudio, skipped } = await up.compress(u.file, p => setItem(u, `压缩中 ${Math.round(p * 100)}%`, Math.round(p * 80)));
        if (blob.size > 90 * 1048576) throw new Error('压缩后仍超过 90 MB，请先剪短');
        const cover = await up.poster(blob).catch(() => null);
        const base = `videos/${id}/${stamp}${String(k + 1).padStart(2, '0')}`;
        files.push({ path: base + '.mp4', blob });
        if (cover) files.push({ path: base + '.jpg', blob: cover });
        added.push({ title: titleOf(u.file.name), src: base + '.mp4', poster: cover ? base + '.jpg' : '', size: blob.size, from: poll.title });
        setItem(u, `${skipped ? '已符合要求，跳过压缩' : '压缩完成'} ${(u.file.size / 1048576).toFixed(0)}→${(blob.size / 1048576).toFixed(1)} MB${noAudio ? '（无声音）' : ''}`, 80);
      } catch (e) { u.error = true; setItem(u, '失败：' + e.message, 100); }
    }
    const ok = upItems.filter(u => !u.error);
    try {
      if (!added.length) throw new Error('没有压缩成功的视频');
      await up.commitFiles(cfg, files, `网页上传：${poll.title}（${added.length} 个）`, step => ok.forEach(u => setItem(u, step, 90)));
      poll = await api('admin.addVideos', { id, videos: added });
      ok.forEach(u => setItem(u, '已上传，等待 GitHub 生效…', 95));
      renderHead(); renderVideos();
      // GitHub Pages 构建通常 1–2 分钟，轮询第一个视频确认可访问
      const probe = added[0].src;
      let live = /^(localhost|127\.)/.test(location.hostname);
      for (let t = 0; t < 40 && !live; t++) {
        const r = await fetch(probe, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
        if (r && r.ok) live = true; else await new Promise(r => setTimeout(r, 8000));
      }
      ok.forEach(u => setItem(u, live ? '✅ 完成，可以播放了' : '✅ 已上传；网站还在更新，几分钟后刷新即可播放', 100));
      toast(`已上传 ${added.length} 个视频`);
    } catch (e) {
      ok.forEach(u => { u.error = true; setItem(u, '失败：' + e.message, 100); });
      toast(e.message, true);
    } finally {
      uploading = false;
      window.onbeforeunload = null;
    }
  };
  const renderVideos = () => {
    const grid = document.getElementById('vgrid');
    if (!grid) return;
    const locked = poll.status !== 'draft';
    document.getElementById('vcount').textContent = `${poll.videos.length} 个`;
    grid.innerHTML = poll.videos.map((v, i) => `
      <div class="card vcard" data-i="${i}">
        <video src="${esc(v.src)}" ${v.poster ? `poster="${esc(v.poster)}"` : ''} preload="none" controls playsinline></video>
        <div class="meta"><span class="no">V${i + 1}</span><input class="title-input" value="${esc(v.title)}" maxlength="100" title="点击修改标题"></div>
        <div class="tools"><span class="muted" style="margin-right:auto;padding-left:4px">${esc(v.from || '')}</span>
          ${!locked ? `<button class="btn ghost sm" data-move="-1" ${i === 0 ? 'disabled' : ''} title="前移">←</button><button class="btn ghost sm" data-move="1" ${i === poll.videos.length - 1 ? 'disabled' : ''} title="后移">→</button><button class="btn ghost sm danger" data-delv>移除</button>` : ''}</div>
      </div>`).join('');
    grid.querySelectorAll('.vcard').forEach(card => {
      const i = +card.dataset.i;
      const ti = card.querySelector('.title-input');
      ti.onkeydown = e => { if (e.key === 'Enter') ti.blur(); };
      ti.onchange = () => { const vs = poll.videos.map(v => ({ ...v })); vs[i].title = ti.value; saveVideos(vs).then(ok => ok && toast('标题已更新')); };
      card.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
        const vs = [...poll.videos], j = i + +b.dataset.move;
        [vs[i], vs[j]] = [vs[j], vs[i]]; saveVideos(vs);
      });
      const d = card.querySelector('[data-delv]');
      if (d) d.onclick = async () => {
        if (!await confirmBox('移除视频', `确定从本投票中移除「${esc(poll.videos[i].title)}」吗？`, '移除', true)) return;
        saveVideos(poll.videos.filter((_, k) => k !== i));
      };
    });
  };

  // 从往期投票导入（用于总评）
  const importModal = async () => {
    const polls = (await api('admin.list')).filter(p => p.id !== id && p.videos.length);
    if (!polls.length) return toast('还没有其他带视频的投票', true);
    const have = new Set(poll.videos.map(v => v.src));
    const sorted = p => {
      const rows = p.videos.map((v, i) => ({ ...v, no: i + 1, votes: (p.counts || {})[v.id] || 0 })).sort((a, b) => b.votes - a.votes || a.no - b.no);
      rows.forEach((r, i) => { r.rank = i > 0 && r.votes === rows[i - 1].votes ? rows[i - 1].rank : i + 1; });
      rows.forEach(r => { r.tie = rows.filter(x => x.rank === r.rank).length > 1; });
      return rows;
    };
    modal(`<div class="spread"><h2 style="margin:0">从往期投票导入视频</h2><div class="row"><span class="muted">每个投票前</span>
      <div class="stepper"><button type="button" data-step="-1">−</button><input id="topn" type="number" min="1" max="50" value="3"><button type="button" data-step="1">＋</button></div>
      <button class="btn sm" id="pickTop">一键勾选</button></div></div>
      <p class="muted">按得票数排序；一键勾选会把并列名次的视频一起选上，可再手动调整。已在本投票中的视频不可重复导入。</p>
      <div style="max-height:55vh;overflow:auto">${polls.map(p => `<div class="import-poll"><header><span>${esc(p.title)} ${badge(p.status)}</span><span class="muted">${p.ballotCount || 0} 人投票</span></header>
        ${sorted(p).map(v => `<label class="import-row ${have.has(v.src) ? 'added' : ''}"><input type="checkbox" data-poll="${p.id}" data-rank="${v.rank}" data-vid="${v.id}" ${have.has(v.src) ? 'disabled' : ''}>
          <span class="no" style="font-size:12px;color:var(--accent)">#${v.rank}${v.tie ? ' 并列' : ''}</span>${esc(v.title)}<span class="votes">${v.votes} 票</span></label>`).join('')}</div>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn" data-close>取消</button><button class="btn primary" id="doImport">导入所选</button></div>`,
      (m, close) => {
        bindSteppers(m);
        m.querySelector('#pickTop').onclick = () => {
          const n = +m.querySelector('#topn').value;
          m.querySelectorAll('input[data-vid]').forEach(c => { if (!c.disabled) c.checked = +c.dataset.rank <= n; });
        };
        m.querySelector('#doImport').onclick = async () => {
          const picked = [...m.querySelectorAll('input[data-vid]:checked')].map(c => {
            const p = polls.find(x => x.id === c.dataset.poll), v = p.videos.find(x => x.id === c.dataset.vid);
            return { title: v.title, src: v.src, poster: v.poster, size: v.size, from: p.title };
          });
          if (!picked.length) return toast('请先勾选视频', true);
          try { poll = await api('admin.addVideos', { id, videos: picked }); close(); toast(`已导入 ${picked.length} 个视频`); renderHead(); renderVideos(); }
          catch (e) { toast(e.message, true); }
        };
      }, true);
  };

  // ----- 结果 & 记录 -----
  const renderData = async () => {
    const tab = currentTab;
    const body = document.getElementById('body');
    body.innerHTML = '<div class="card empty">加载中…</div>';
    let data;
    try { data = await api('admin.ballots', { id }); } catch (e) { body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    if (currentTab !== tab || location.hash !== `#/admin/${id}`) return;
    poll = data.poll; renderHead(); renderTabs();
    if (!poll.cutoff) scope = 'all';
    markDuplicates(data.ballots);
    const ballots = data.ballots.filter(inScope(poll, scope));
    const afterCut = data.ballots.length - ballots.length;
    const dupCount = ballots.filter(b => b.dup).length;
    const r = tallyBallots(poll, ballots);
    const scopeBar = poll.cutoff ? `<div class="spread"><div class="tabs">
        <button data-scope="cutoff" class="${scope === 'cutoff' ? 'on' : ''}">🏆 截至第一截止 ${fmt(poll.cutoff)}</button>
        <button data-scope="all" class="${scope === 'all' ? 'on' : ''}">全部选票</button></div>
      <span class="muted">${scope === 'cutoff' ? (Date.now() < Date.parse(poll.cutoff) ? '第一截止未到，目前与全部选票相同' : `第一截止后又投了 ${afterCut} 张，未计入`) : `共 ${ballots.length} 张`}</span></div>` : '';
    const dupNote = dupCount ? `<div class="notice">⚠️ 有 <b>${dupCount}</b> 张选票疑似来自已投过票的设备（同设备特征 + 同网络）。同型号手机在同一网络下也可能被误判，请到「投票记录」核查后决定是否作废。以下统计<b>包含</b>这些选票。</div>` : '';
    const totalPicks = ballots.reduce((s, b) => s + b.choices.length, 0);
    const vlabel = new Map(poll.videos.map((v, i) => [v.id, `V${i + 1} ${v.title}`]));
    const toolbar = `<div class="row"><button class="btn sm" id="refresh">↻ 刷新</button>
      <button class="btn primary sm" data-exp="xlsx">📥 导出 Excel${scope === 'cutoff' ? '（截至第一截止）' : ''}</button><button class="btn sm" data-exp="csv">CSV 明细</button><button class="btn sm" data-exp="json">JSON</button></div>`;
    if (tab === 'results') {
      body.innerHTML = scopeBar + dupNote + `
        <div class="grid2">
          ${[['投票人数', r.total], ['总选票', totalPicks], ['候选视频', poll.videos.length], ['人均选择', r.total ? (totalPicks / r.total).toFixed(1) : '—']]
          .map(([k, v]) => `<div class="card pad"><div class="muted">${k}</div><div style="font-size:30px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${v}</div></div>`).join('')}
        </div>
        <div class="card pad"><div class="spread" style="margin-bottom:20px"><div><h2 style="margin:0">得票排行</h2>
          <span class="muted">得票率 = 得票数 ÷ 投票人数 · 更新于 ${fmtFull(Date.now()).slice(11)}${poll.status === 'open' ? ' · 页面在前台时每 30 秒自动刷新' : ''}</span></div>${toolbar}</div>
          ${r.total ? barChart(r.rows, r.total) : '<div class="empty"><div class="big">📭</div>还没有人投票</div>'}
        </div>`;
    } else {
      const list = [...ballots].reverse();
      body.innerHTML = scopeBar + dupNote + `<div class="card pad"><div class="spread" style="margin-bottom:16px"><h2 style="margin:0">投票记录</h2>${toolbar}</div>
        ${dupCount ? `<div class="row" style="margin-bottom:14px"><button class="btn sm danger" id="voidDups">作废全部疑似重复票（${dupCount} 张，每组保留最早一张）</button>
          <label class="switch" style="font-size:13px"><input type="checkbox" id="onlyDup"><span class="track"></span>只看疑似重复</label></div>` : ''}
        ${list.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>投票人</th><th>时间</th><th>所选视频</th><th>IP</th><th></th></tr></thead><tbody>
        ${list.map((b, i) => `<tr data-g="${b.group || ''}"><td class="muted">${list.length - i}</td><td><b>${esc(b.voterName || '（匿名）')}</b>${b.group ? `<br><span class="badge ${b.dup ? 'closed' : 'draft'}" style="margin-top:4px">设备组 ${b.group}${b.dup ? ' · 疑似重复' : ' · 首票'}</span>` : ''}</td><td class="muted" style="white-space:nowrap">${fmt(b.createdAt)}</td>
          <td>${b.choices.map(c => `<span class="badge draft" style="margin:2px">${esc(vlabel.get(c) || c)}</span>`).join('')}</td><td class="muted">${esc(b.ip)}</td>
          <td><button class="btn ghost sm danger" data-void="${esc(b.id)}" title="作废这张选票">作废</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><div class="big">📭</div>暂无投票记录</div>'}</div>`;
      const vd = document.getElementById('voidDups');
      if (vd) vd.onclick = async () => {
        const dups = ballots.filter(b => b.dup);
        if (!await confirmBox('作废疑似重复票', `将作废 ${dups.length} 张疑似重复选票，每个设备组保留最早投出的一张。作废后不可恢复，建议先导出 Excel 留底。`, '全部作废', true)) return;
        vd.disabled = true;
        let done = 0;
        for (const b of dups) { try { await api('admin.voidBallot', { id, ballotId: b.id }); done++; vd.textContent = `作废中 ${done}/${dups.length}…`; } catch (e) { toast(e.message, true); } }
        toast(`已作废 ${done} 张`); renderData();
      };
      const od = document.getElementById('onlyDup');
      if (od) od.onchange = () => body.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = od.checked && !tr.dataset.g ? 'none' : ''; });
      body.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
        if (!await confirmBox('作废选票', '该选票将被删除且不计入结果，该投票者可以重新投票。', '作废', true)) return;
        try { await api('admin.voidBallot', { id, ballotId: b.dataset.void }); toast('已作废'); renderData(); } catch (e) { toast(e.message, true); }
      });
    }
    document.getElementById('refresh').onclick = renderData;
    body.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; renderData(); });
    body.querySelectorAll('[data-exp]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await exportPoll(id, b.dataset.exp, scope); } catch (e) { toast(e.message, true); }
      b.disabled = false;
    });
    // 仅进行中、页面可见时每 30 秒刷新（避免后台长时间挂着消耗资源点）
    if (poll.status === 'open' && !timer) timer = setInterval(() => {
      if (document.hidden || location.hash !== `#/admin/${id}` || currentTab === 'setup' || document.querySelector('.modal-bg')) return;
      renderData();
    }, 30000);
  };

  $app.innerHTML = `<div id="head"></div><div style="margin:26px 0 20px" class="tabs" id="tabs"></div><div id="body" class="stack"></div>`;
  renderAll();
}

// ---------- 投票者页面 ----------
async function votePage(id) {
  $app.innerHTML = '<div class="card empty">加载中…</div>';
  let poll;
  const fp = await deviceFp();
  try { poll = await api('poll', { id, voter: auth.voter, fp }); }
  catch (e) { $app.innerHTML = `<div class="card empty"><div class="big">🔍</div>${esc(e.message)}</div>`; return; }
  document.title = poll.title;
  const rule = poll.minChoices === poll.maxChoices ? `请选出 <b>${poll.maxChoices}</b> 个你最喜欢的视频` : `请选出 <b>${poll.minChoices}–${poll.maxChoices}</b> 个你最喜欢的视频`;
  const head = BANNER + `<section class="vote-head"><h1>${esc(poll.title)}</h1>${poll.description ? `<p class="sub">${esc(poll.description)}</p>` : ''}
    <div class="row">${poll.status === 'closed' ? '<span class="rule">⏹ 投票已结束</span>'
      : `<span class="rule">🗳️ ${rule}</span>${poll.cutoff ? `<span class="rule">⏰ ${poll.cutoffPassed ? `评选已于 ${fmt(poll.cutoff)} 截止统计，仍可继续投票` : `${fmt(poll.cutoff)} 评选截止${poll.cutoffNote ? ' · ' + esc(poll.cutoffNote) : ''}`}</span>` : ''}`}<span class="rule">🎬 共 ${poll.videos.length} 个候选</span></div></section>`;
  const byId = new Map(poll.videos.map(v => [v.id, v]));
  // 结果卡片：过了第一截止就是"评选结果"（只算截止前的票），并标出第一名
  const R = poll.results;
  const winners = R && R.total ? R.rows.filter(r => r.rank === 1 && r.votes > 0) : [];
  const results = R ? `<div class="card pad" style="margin-top:24px"><h2>${R.cutoff ? '🏆 评选结果' : poll.status === 'closed' ? '最终结果' : '实时结果'} <span class="muted">· ${R.total} 人参与</span></h2>
    ${R.cutoff ? `<p class="muted" style="margin:-8px 0 16px">按 ${fmt(R.cutoff)} 评选截止前的投票统计</p>` : ''}
    ${winners.length ? `<div class="winner">🏆 最佳：${winners.map(w => esc(w.title)).join('、')}${winners.length > 1 ? '（并列）' : ''}<span>${winners[0].votes} 票</span></div>` : ''}
    ${R.total ? barChart(R.rows, R.total) : '<p class="muted">暂无投票</p>'}</div>` : '';
  // 已结束：按名次列出视频，可直接观看获奖作品
  const ranked = R && R.total ? R.rows.map(r => ({ ...byId.get(r.id), rank: r.rank, votes: r.votes })).filter(v => v.src) : poll.videos;
  const replay = `<h2 style="margin:30px 0 14px">${R && R.total ? '视频回看（按名次）' : '全部视频'}</h2><div class="video-grid">${ranked.map(v => `
    <div class="card vcard">
      <video src="${esc(v.src)}" ${v.poster ? `poster="${esc(v.poster)}"` : ''} preload="none" controls playsinline></video>
      <div class="meta">${v.rank ? `<span class="no">${v.rank === 1 && v.votes ? '🏆 ' : ''}第 ${v.rank} 名</span>` : ''}<span class="title">${esc(v.title)}</span>${v.rank ? `<span class="muted">${v.votes} 票</span>` : ''}</div>
    </div>`).join('')}</div>`;

  if (poll.status === 'closed') {
    const mine = poll.myBallot ? `你投了：${poll.myBallot.choices.map(c => esc(byId.get(c)?.title || c)).join('、')}。` : '';
    $app.innerHTML = head + (mine || !R ? `<p class="muted" style="text-align:center">${mine}${R ? '' : '结果由组织者另行公布，感谢参与。'}</p>` : '') + results + replay;
    return;
  }
  if (poll.myBallot) {
    $app.innerHTML = head + `<div class="card done-card"><div class="big">🎉</div><h1>感谢参与！</h1>
      <p class="muted">${poll.myBallot.voterName ? esc(poll.myBallot.voterName) + ' · ' : ''}投票于 ${fmt(poll.myBallot.createdAt)}</p>
      <p style="margin-top:18px">你的选择：</p><div class="row" style="justify-content:center">${poll.myBallot.choices.map(c => `<span class="badge open">${esc(byId.get(c)?.title || c)}</span>`).join('')}</div>
      ${!poll.results && poll.status === 'open' ? '<p class="muted" style="margin-top:20px">结果将在投票结束后公布</p>' : ''}</div>` + results;
    return;
  }

  const picked = [];
  const seen = poll.deviceSeen ? '<div class="notice" style="margin-bottom:20px">⚠️ 检测到这台设备在本投票中已有投票记录。每人限投一次，重复投票会被标记，组织者可能将其作废。如果是和别人共用设备，可以忽略本提示。</div>' : '';
  $app.innerHTML = head + seen + `<div class="video-grid">${poll.videos.map((v, i) => `
    <div class="card vcard selectable" data-id="${v.id}">
      <video src="${esc(v.src)}" ${v.poster ? `poster="${esc(v.poster)}"` : ''} preload="none" controls playsinline></video>
      <div class="meta"><span class="no">${i + 1}</span><span class="title">${esc(v.title)}</span></div>
      <button class="btn select-btn">选择这个</button>
    </div>`).join('')}</div>${results}
    <div class="dock"><div class="count">已选 <b id="cnt">0</b> / ${poll.maxChoices}</div><div class="chips" id="chips"></div>
      ${poll.requireName ? `<input class="input" id="vname" placeholder="你的姓名" maxlength="50">` : ''}
      <button class="btn primary" id="submit" disabled>提交投票</button></div>`;

  const update = () => {
    $app.querySelectorAll('.vcard').forEach(c => {
      const k = picked.indexOf(c.dataset.id);
      c.classList.toggle('selected', k >= 0);
      c.classList.toggle('dim', k < 0 && picked.length >= poll.maxChoices);
      c.querySelector('.select-btn').textContent = k >= 0 ? `✓ 已选（第 ${k + 1} 个）` : '选择这个';
    });
    document.getElementById('cnt').textContent = picked.length;
    document.getElementById('chips').innerHTML = picked.map(p => `<span class="chip">${esc(byId.get(p).title)}</span>`).join('');
    document.getElementById('submit').disabled = picked.length < poll.minChoices;
  };
  const toggle = vid => {
    const k = picked.indexOf(vid);
    if (k >= 0) picked.splice(k, 1);
    else if (picked.length >= poll.maxChoices) return toast(`最多只能选 ${poll.maxChoices} 个，请先取消一个`, true);
    else picked.push(vid);
    update();
  };
  $app.querySelectorAll('.vcard').forEach(c => c.addEventListener('click', e => { if (!e.target.closest('video')) toggle(c.dataset.id); }));
  document.getElementById('submit').onclick = async () => {
    const nameEl = document.getElementById('vname');
    const voterName = nameEl ? nameEl.value.trim() : '';
    if (poll.requireName && !voterName) { nameEl.focus(); return toast('请填写姓名', true); }
    const ok = await confirmBox('确认提交', `${voterName ? `投票人：<b>${esc(voterName)}</b><br>` : ''}你选择了：<br>${picked.map((p, i) => `${i + 1}. ${esc(byId.get(p).title)}`).join('<br>')}<br><br><span class="muted">提交后不可修改。</span>`, '确认提交');
    if (!ok) return;
    const btn = document.getElementById('submit'); btn.disabled = true; btn.textContent = '提交中…';
    try { await api('vote', { id, voter: auth.voter, voterName, choices: picked, fp }); toast('投票成功！'); votePage(id); }
    catch (e) {
      toast(e.message, true); btn.textContent = '提交投票'; btn.disabled = false;
      if (e.status === 409 && /结束|你已经投过/.test(e.message)) votePage(id);
    }
  };
  update();
}

router();
