// ซอร์สของหน้าสมอง — build เป็น ../viewer.bundle.js ด้วย: npm run build
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const COLORS = {
  brain: '#ffffff', machine: '#fff4d6', dir: '#ffd9a0',
  media: '#ff9a3c', code: '#3c8dff', doc: '#7fb8ff', brand: '#ff6a3c',
  rules: '#ffd84a', data: '#6fe3d0', other: '#c9b8ff',
};
const LINK_COLORS = {
  contains: 'rgba(255,220,180,0.10)', ref: 'rgba(120,180,255,0.75)',
  twin: 'rgba(255,120,220,0.9)', network: 'rgba(255,255,255,0.8)',
};
const KIND_TXT = { contains: 'อยู่ใน/มี', ref: 'อ้างอิง', twin: 'ไฟล์เดียวกันอีกเครื่อง', network: 'เครือข่าย' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const token = new URLSearchParams(location.search).get('token') || '';
const api = (path, opts = {}) =>
  fetch(path, { ...opts, headers: { 'X-Brain-Token': token, 'Content-Type': 'application/json' } })
    .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || r.status)))));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtSize = (b) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0)} ${u[i]}`; };
const ago = (t) => { const s = Date.now() / 1000 - t; return s < 60 ? 'เมื่อกี้' : s < 3600 ? `${Math.floor(s / 60)} นาทีที่แล้ว` : s < 86400 ? `${Math.floor(s / 3600)} ชม.ที่แล้ว` : new Date(t * 1000).toLocaleDateString('th-TH'); };
const host = (u) => u.replace(/^https?:\/\//, '');

let data = { nodes: [], links: [], machines: [] };
let cats = {};
let hidden = new Set();
let highlight = new Set();
let me = {};
let peers = {};

// ---------------------------------------------------------------- graph
const Graph = ForceGraph3D()($('#graph'))
  .backgroundColor('#03040a')
  .showNavInfo(false)
  .nodeRelSize(3)
  .nodeVal((n) => ({ brain: 60, machine: 30, dir: 3 + Math.min(n.deg || 0, 30) / 3 }[n.kind] ?? 1 + Math.min(n.deg || 0, 20) / 4))
  .nodeColor((n) => (highlight.size && !highlight.has(n.id) ? '#252a40' : COLORS[n.cat] || COLORS.other))
  .nodeOpacity(0.95)
  .nodeResolution(10)
  .nodeLabel((n) => `<div class="tip"><b>${esc(n.name)}</b><br>${esc(n.machine === '*' ? 'สมองกลาง' : n.machine)} · ${esc(catLabel(n))}${n.size ? ' · ' + fmtSize(n.size) : ''}</div>`)
  .nodeVisibility((n) => !hidden.has(n.cat))
  .linkVisibility((l) => !hidden.has(l.source.cat ?? '') && !hidden.has(l.target.cat ?? ''))
  .linkColor((l) => LINK_COLORS[l.type] || LINK_COLORS.contains)
  .linkWidth((l) => (l.type === 'network' ? 1.2 : l.type === 'twin' ? 0.8 : l.type === 'ref' ? 0.4 : 0))
  .linkDirectionalParticles((l) => (l.type === 'ref' || l.type === 'network' || l.type === 'twin' ? 2 : 0))
  .linkDirectionalParticleWidth(1.4)
  .linkDirectionalParticleSpeed(0.006)
  .onNodeClick((n, ev) => (ev.ctrlKey || ev.metaKey ? openFile(n) : focus(n)))
  .cooldownTicks(200)
  .onEngineStop(() => { if (!fitted) { fitted = true; Graph.zoomToFit(800, 60); } })
  .onBackgroundClick(() => select(null));
let fitted = false;
Graph.d3Force('charge').strength(-18);
Graph.d3Force('link').distance((l) => ({ network: 120, contains: 14, ref: 40, twin: 60 }[l.type] || 20));
Graph.postProcessingComposer().addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.1, 0.5, 0.2));
{
  const g = new THREE.BufferGeometry();
  const N = 4000, pos = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 6000;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  Graph.scene().add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899ff, size: 1.5, transparent: true, opacity: 0.35 })));
}
const catLabel = (n) => cats[n.cat] || { brain: 'สมองกลาง', machine: 'คอมพิวเตอร์', dir: 'โฟลเดอร์' }[n.cat] || n.cat;
const refreshColors = () => Graph.nodeColor(Graph.nodeColor());

// ---------------------------------------------------------------- load
async function load() {
  try {
    const g = await api('/api/graph');
    cats = g.cats || {};
    peers = g.peers || {};
    const deg = {};
    for (const l of g.links) { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1; }
    g.nodes.forEach((n) => (n.deg = deg[n.id] || 0));
    const sig = (x) => x.nodes.length + ':' + x.links.length + ':' + x.machines.map((m) => m.scanned_at).join();
    if (sig(g) !== sig(data)) {          // ข้อมูลเปลี่ยนจริง → วาดใหม่
      data = g;
      Graph.graphData({ nodes: g.nodes, links: g.links });
    } else {                              // ไม่เปลี่ยน → เก็บโหนดเดิม (มีตำแหน่งแล้ว) อัปเดตแค่ข้อมูลเครื่อง
      data.machines = g.machines; data.peers = g.peers;
    }
    renderLegend();
    renderChips();
    renderPeers();
    const files = g.nodes.filter((n) => n.kind === 'file').length;
    const refs = g.links.filter((l) => l.type === 'ref').length;
    const twins = g.links.filter((l) => l.type === 'twin').length;
    $('#sub').textContent = `${g.machines.length} เครื่อง · ${files.toLocaleString()} ไฟล์`;
    $('#stats').innerHTML = `${files.toLocaleString()} ไฟล์ · ${refs.toLocaleString()} เส้นอ้างอิง<br>${twins} ไฟล์ที่อยู่หลายเครื่อง`;
  } catch (e) {
    $('#sub').textContent = 'โหลดไม่ได้: ' + e.message;
  }
}

function renderLegend() {
  const count = {};
  data.nodes.forEach((n) => (count[n.cat] = (count[n.cat] || 0) + 1));
  $('#cats').innerHTML = Object.entries(cats).filter(([k]) => count[k])
    .map(([k, label]) => `<label class="${hidden.has(k) ? 'off' : ''}"><input type="checkbox" data-cat="${k}" ${hidden.has(k) ? '' : 'checked'}><i class="sw" style="background:${COLORS[k]};box-shadow:0 0 10px ${COLORS[k]}"></i>${esc(label)}<span>${count[k].toLocaleString()}</span></label>`).join('');
  $$('#cats input').forEach((el) => el.addEventListener('change', () => {
    el.checked ? hidden.delete(el.dataset.cat) : hidden.add(el.dataset.cat);
    el.parentElement.classList.toggle('off', !el.checked);
    Graph.nodeVisibility(Graph.nodeVisibility()).linkVisibility(Graph.linkVisibility());
  }));
}

function renderChips() {
  const bad = new Set(Object.entries(peers).filter(([, p]) => !p.ok).map(([u]) => u));
  $('#chips').innerHTML = data.machines.map((m) => {
    const isMe = m.name === me.machine;
    return `<div class="chip" title="${m.files} ไฟล์ · สแกน ${ago(m.scanned_at)}"><span class="dot"></span>${esc(m.name)}${isMe ? ' <span style="color:var(--dim)">(เครื่องนี้)</span>' : ''}</div>`;
  }).join('') + [...bad].map((u) => `<div class="chip" title="${esc(peers[u].error)}"><span class="dot off"></span>${esc(host(u))}</div>`).join('');
}

// ---------------------------------------------------------------- select / info
function neighbors(n) {
  const out = [];
  for (const l of data.links) {
    if (l.source.id === n.id) out.push([l.type, l.target]);
    else if (l.target.id === n.id) out.push([l.type, l.source]);
  }
  return out;
}

function select(n) {
  highlight = new Set();
  const info = $('#info');
  if (!n) { info.hidden = true; refreshColors(); return; }
  const nb = neighbors(n);
  highlight.add(n.id); nb.forEach(([, m]) => highlight.add(m.id));
  const rows = nb.filter(([t]) => t !== 'contains' || n.kind !== 'dir').slice(0, 50)
    .map(([t, m]) => `<li class="row" data-id="${esc(m.id)}"><i class="sw" style="background:${COLORS[m.cat] || '#fff'}"></i><span class="name">${esc(m.name)}</span><span class="meta">${KIND_TXT[t] || t}${m.machine !== n.machine && m.machine !== '*' ? ' · ' + esc(m.machine) : ''}</span></li>`).join('');
  info.hidden = false;
  info.innerHTML = `<button class="close" aria-label="ปิด">✕</button>
    <div class="label">${esc(catLabel(n))}</div>
    <h3>${esc(n.name)}</h3>
    <p>${n.machine === '*' ? 'รวมทุกเครื่อง' : '💻 ' + esc(n.machine)}${n.size ? ' · ' + fmtSize(n.size) : ''}${n.mtime ? ' · แก้ไข ' + ago(n.mtime) : ''}</p>
    ${n.path ? `<code>${esc(n.path)}</code>` : ''}
    ${n.path && n.machine === me.machine ? '<button class="btn" id="open" style="width:100%;margin-bottom:12px">📂 เปิดในโฟลเดอร์</button>' : ''}
    <div class="label">เชื่อมกับ ${nb.length} อย่าง</div><ul>${rows}</ul>`;
  $('.close', info).addEventListener('click', () => select(null));
  $$('li', info).forEach((li) => li.addEventListener('click', () => focus(data.nodes.find((x) => x.id === li.dataset.id))));
  $('#open')?.addEventListener('click', () => openFile(n));
  refreshColors();
}

function focus(n) {
  if (!n) return;
  stopSpin();
  const d = 90, r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
  Graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 1400);
  select(n);
}

async function openFile(n) {
  if (!n.path) return;
  try { await api('/api/open', { method: 'POST', body: JSON.stringify({ id: n.id }) }); toast('เปิดแล้ว: ' + n.name); }
  catch (e) { toast(e.message); }
}

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }

// ---------------------------------------------------------------- search
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const hits = q ? data.nodes.filter((n) => n.name.toLowerCase().includes(q) || (n.path || '').toLowerCase().includes(q)).slice(0, 10) : [];
  $('#hits').classList.toggle('on', !!q);
  $('#hits').innerHTML = hits.length ? hits.map((n) => `<li class="row" data-id="${esc(n.id)}"><i class="sw" style="background:${COLORS[n.cat] || '#fff'}"></i><span class="name">${esc(n.name)}</span><span class="meta">${esc(n.machine)}</span></li>`).join('')
    : q ? '<li class="row" style="cursor:default;color:var(--dim)">ไม่เจอไฟล์นี้</li>' : '';
  $$('#hits li[data-id]').forEach((li) => li.addEventListener('click', () => {
    focus(data.nodes.find((x) => x.id === li.dataset.id)); $('#hits').classList.remove('on');
  }));
  highlight = new Set(hits.map((n) => n.id)); refreshColors();
});
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#hits li[data-id]')?.click(); if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); } });

// ---------------------------------------------------------------- tools
let spin = true, angle = 0;
setInterval(() => {
  if (!spin) return;
  const p = Graph.cameraPosition(); const dist = Math.hypot(p.x, p.z) || 600;
  angle += 0.0018;
  Graph.cameraPosition({ x: dist * Math.sin(angle), z: dist * Math.cos(angle) });
}, 16);
function stopSpin() { spin = false; $('#spin').classList.remove('on'); }
$('#spin').addEventListener('click', () => { spin = !spin; $('#spin').classList.toggle('on', spin); });
$('#graph').addEventListener('pointerdown', stopSpin);
$('#fit').addEventListener('click', () => { select(null); Graph.zoomToFit(800, 60); });
$('#rescan').addEventListener('click', async () => {
  const b = $('#rescan'); b.classList.add('spin'); toast('กำลังสแกนเครื่องนี้ใหม่…');
  try { await api('/api/rescan', { method: 'POST' }); await load(); toast('สแกนเสร็จแล้ว'); } catch (e) { toast(e.message); }
  b.classList.remove('spin');
});
$('#export').href = '/api/knowledge.md' + (token ? '?token=' + encodeURIComponent(token) : '');

// ---------------------------------------------------------------- connect computers
const modal = $('#modal');
const openModal = () => { modal.classList.add('on'); lastSig = null; pollNearby(); };
const closeModal = () => modal.classList.remove('on');
$('#connectOpen').addEventListener('click', openModal);
$('#connectClose').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function connect(addr, code, msgEl, btn) {
  msgEl.className = 'msg'; msgEl.textContent = 'กำลังเชื่อม…'; btn.disabled = true;
  try {
    const r = await api('/api/peers', { method: 'POST', body: JSON.stringify({ url: addr, token: code.trim() }) });
    msgEl.className = 'msg ok'; msgEl.textContent = `✅ เชื่อมสำเร็จ! ได้ข้อมูลมา ${r.got} เครื่อง`;
    toast('🧠 เชื่อมสมองสำเร็จ');
    await load(); lastSig = null; pollNearby();
    return true;
  } catch (e) {
    msgEl.className = 'msg err'; msgEl.textContent = '❌ ' + e.message;
    return false;
  } finally { btn.disabled = false; }
}

let nearbyList = [];
let lastSig = null;
async function pollNearby() {
  try { nearbyList = await api('/api/nearby'); } catch { nearbyList = []; }
  const fresh = nearbyList.filter((n) => !n.connected);
  $('#connectOpen').classList.toggle('pulse', fresh.length > 0 && !modal.classList.contains('on'));
  $('#badge').textContent = fresh.length;
  if (!modal.classList.contains('on')) return;
  const sig = nearbyList.map((n) => n.addr + n.machine + n.connected).join('|');
  if (sig === lastSig) return;      // ไม่เปลี่ยน → ไม่วาดใหม่ (ข้อความ/รหัสที่พิมพ์ไม่หาย)
  lastSig = sig;
  const box = $('#nearby');
  const open = $('.pc.open', box)?.dataset.addr;
  const typed = open ? $('.pc.open .pin', box)?.value : '';
  box.innerHTML = nearbyList.map((n) => `
    <div class="pc ${n.addr === open ? 'open' : ''}" data-addr="${esc(n.addr)}">
      <div class="ico">💻</div>
      <div><b>${esc(n.machine)}</b><small>${esc(n.addr)}</small></div>
      ${n.connected ? '<span class="tag-ok">✓ เชื่อมแล้ว</span>' : '<button class="btn go">เชื่อม</button>'}
      <div class="pair"><input class="pin" maxlength="6" inputmode="numeric" placeholder="••••••" aria-label="รหัส 6 หลัก"><button class="btn ok">ยืนยัน</button></div>
      <div class="msg" style="grid-column:1/-1"></div>
    </div>`).join('');
  $('#nearbyEmpty').hidden = nearbyList.length > 0;
  $$('.pc', box).forEach((pc) => {
    const pin = $('.pin', pc), msg = $('.msg', pc);
    if (pc.dataset.addr === open) pin.value = typed;
    $('.go', pc)?.addEventListener('click', () => {
      $$('.pc', box).forEach((x) => x !== pc && x.classList.remove('open'));
      pc.classList.add('open');
      msg.className = 'msg'; msg.textContent = `ดูรหัส 6 หลักที่หน้าจอของ ${$('b', pc).textContent} แล้วพิมพ์ที่นี่`;
      pin.focus();
    });
    const submit = () => pin.value.length >= 4 && connect(pc.dataset.addr, pin.value, msg, $('.ok', pc));
    $('.ok', pc).addEventListener('click', submit);
    pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, ''); if (pin.value.length === 6) submit(); });
    pin.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  });
}
setInterval(pollNearby, 3000);

$('#mGo').addEventListener('click', () => connect($('#mIp').value, $('#mCode').value, $('#mMsg'), $('#mGo')));

function renderPeers() {
  const list = Object.entries(peers);
  $('#peersCard').hidden = !list.length;
  $('#peers').innerHTML = list.map(([u, p]) => {
    const m = nearbyList.find((n) => n.addr === host(u));
    return `<div class="peer"><span class="dot ${p.ok ? '' : 'off'}"></span>
      <div><b>${esc(m?.machine || host(u))}</b><small>${p.ok ? `sync ล่าสุด ${ago(p.at)} · ${esc(host(u))}` : esc(p.error)}</small></div>
      <button class="x" data-url="${esc(u)}">ยกเลิกการเชื่อม</button></div>`;
  }).join('');
  $$('#peers .x').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('ยกเลิกการเชื่อมกับเครื่องนี้?')) return;
    await api('/api/peers', { method: 'POST', body: JSON.stringify({ url: b.dataset.url, remove: true }) }).catch((e) => toast(e.message));
    load(); pollNearby();
  }));
}

api('/api/info').then((i) => {
  me = i;
  $('#meName').textContent = i.machine;
  $('#meAddr').textContent = i.lan ? i.addr : 'เปิดแบบ --local-only (เครื่องอื่นเชื่อมไม่ได้)';
  $('#meCode').textContent = i.token ? i.token.replace(/^(\d{3})(\d{3})$/, '$1 $2') : '—';
  renderChips();
}).catch(() => {});

addEventListener('resize', () => Graph.width(innerWidth).height(innerHeight));
load().then(pollNearby);
setInterval(load, 30 * 1000);
window.Graph = Graph;
