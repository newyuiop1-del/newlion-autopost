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

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token') || '';
const api = (path, opts = {}) =>
  fetch(path, { ...opts, headers: { 'X-Brain-Token': token, 'Content-Type': 'application/json' } })
    .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || r.status)))));

let data = { nodes: [], links: [] };
let hidden = new Set();
let highlight = new Set();
let selected = null;

const Graph = ForceGraph3D()($('#graph'))
  .backgroundColor('#03040a')
  .showNavInfo(false)
  .nodeRelSize(3)
  .nodeVal((n) => ({ brain: 60, machine: 30, dir: 3 + Math.min(n.deg || 0, 30) / 3 }[n.kind] ?? 1 + Math.min(n.deg || 0, 20) / 4))
  .nodeColor((n) => (highlight.size && !highlight.has(n.id) ? '#2a2f45' : COLORS[n.cat] || COLORS.other))
  .nodeOpacity(0.95)
  .nodeResolution(10)
  .nodeLabel((n) => `<div class="tip"><b>${esc(n.name)}</b><br>${esc(n.machine)} · ${esc(CAT_LABEL(n))}${n.size ? ' · ' + fmtSize(n.size) : ''}</div>`)
  .nodeVisibility((n) => !hidden.has(n.cat))
  .linkVisibility((l) => !hidden.has(l.source.cat ?? '') && !hidden.has(l.target.cat ?? ''))
  .linkColor((l) => LINK_COLORS[l.type] || LINK_COLORS.contains)
  .linkWidth((l) => (l.type === 'network' ? 1.2 : l.type === 'twin' ? 0.8 : l.type === 'ref' ? 0.4 : 0))
  .linkDirectionalParticles((l) => (l.type === 'ref' || l.type === 'network' || l.type === 'twin' ? 2 : 0))
  .linkDirectionalParticleWidth(1.4)
  .linkDirectionalParticleSpeed(0.006)
  .onNodeClick((n, ev) => {
    if (ev.ctrlKey || ev.metaKey) return openFile(n);
    select(n);
  })
  .cooldownTicks(200)
  .onEngineStop(() => { if (!fitted) { fitted = true; Graph.zoomToFit(800, 40); } })
  .onBackgroundClick(() => select(null));
let fitted = false;

Graph.d3Force('charge').strength(-18);
Graph.d3Force('link').distance((l) => ({ network: 120, contains: 14, ref: 40, twin: 60 }[l.type] || 20));

// แสงเรืองแบบในวิดีโอ
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.1, 0.5, 0.2);
Graph.postProcessingComposer().addPass(bloom);

// ดาวพื้นหลัง
{
  const g = new THREE.BufferGeometry();
  const N = 4000, pos = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 6000;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  Graph.scene().add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899ff, size: 1.5, transparent: true, opacity: 0.35 })));
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
function fmtSize(b) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0)} ${u[i]}`; }
let cats = {};
function CAT_LABEL(n) { return cats[n.cat] || { brain: 'สมองกลาง', machine: 'คอมพิวเตอร์', dir: 'โฟลเดอร์' }[n.cat] || n.cat; }

async function load() {
  $('#status').textContent = 'กำลังโหลด…';
  try {
    const g = await api('/api/graph');
    cats = g.cats || {};
    const deg = {};
    for (const l of g.links) { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1; }
    g.nodes.forEach((n) => (n.deg = deg[n.id] || 0));
    data = g;
    Graph.graphData({ nodes: g.nodes, links: g.links });
    renderLegend(g);
    const files = g.nodes.filter((n) => n.kind === 'file').length;
    const refs = g.links.filter((l) => l.type === 'ref').length;
    const twins = g.links.filter((l) => l.type === 'twin').length;
    $('#status').innerHTML = `${g.machines.length} เครื่อง · ${files.toLocaleString()} ไฟล์ · ${refs} เส้นอ้างอิง · ${twins} ไฟล์ซ้ำข้ามเครื่อง`;
    const peers = Object.entries(g.peers || {});
    $('#peers').innerHTML = peers.length ? peers.map(([u, p]) => `<li>${p.ok ? '🟢' : '🔴'} 🧠 ${esc(u.replace(/^https?:\/\//, ''))} <button data-url="${esc(u)}">ยกเลิก</button><span style="flex-basis:100%;margin:0">${p.ok ? 'เชื่อมอยู่ · sync ล่าสุด ' + new Date(p.at * 1000).toLocaleTimeString('th-TH') : esc(p.error)}</span></li>`).join('')
      : '';
    $('#peers').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/peers', { method: 'POST', body: JSON.stringify({ url: b.dataset.url, remove: true }) }).catch((e) => toast(e.message));
      load();
    }));
    $('#machines').innerHTML = g.machines.map((m) => `<li>💻 ${esc(m.name)} <span>${m.files} ไฟล์ · ${new Date(m.scanned_at * 1000).toLocaleString('th-TH')}</span></li>`).join('');
  } catch (e) {
    $('#status').textContent = 'โหลดไม่ได้: ' + e.message + (token ? '' : ' (ต้องเปิดด้วย ?token=...)');
  }
}

function renderLegend(g) {
  const count = {};
  g.nodes.forEach((n) => (count[n.cat] = (count[n.cat] || 0) + 1));
  $('#legend').innerHTML = Object.entries(cats)
    .filter(([k]) => count[k])
    .map(([k, label]) => `<label><input type="checkbox" data-cat="${k}" ${hidden.has(k) ? '' : 'checked'}><i style="background:${COLORS[k]};box-shadow:0 0 8px ${COLORS[k]}"></i>${esc(label)} <span>${count[k]}</span></label>`)
    .join('');
  $('#legend').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    el.checked ? hidden.delete(el.dataset.cat) : hidden.add(el.dataset.cat);
    Graph.nodeVisibility(Graph.nodeVisibility()).linkVisibility(Graph.linkVisibility());
  }));
}

function neighbors(n) {
  const out = [];
  for (const l of data.links) {
    if (l.source.id === n.id) out.push([l.type, l.target]);
    else if (l.target.id === n.id) out.push([l.type, l.source]);
  }
  return out;
}

function select(n) {
  selected = n;
  highlight = new Set();
  if (!n) { $('#info').hidden = true; refresh(); return; }
  const nb = neighbors(n);
  highlight.add(n.id); nb.forEach(([, m]) => highlight.add(m.id));
  const kindTxt = { contains: 'อยู่ใน/มี', ref: 'อ้างอิง', twin: 'ไฟล์เดียวกันอีกเครื่อง', network: 'เครือข่าย' };
  const rows = nb.filter(([t]) => t !== 'contains' || n.kind !== 'dir').slice(0, 40)
    .map(([t, m]) => `<li data-id="${esc(m.id)}"><i style="background:${COLORS[m.cat] || '#fff'}"></i>${esc(m.name)} <span>${kindTxt[t] || t}${m.machine !== n.machine ? ' · ' + esc(m.machine) : ''}</span></li>`).join('');
  $('#info').hidden = false;
  $('#info').innerHTML = `<h3>${esc(n.name)}</h3>
    <p>${esc(CAT_LABEL(n))} · ${esc(n.machine)}${n.size ? ' · ' + fmtSize(n.size) : ''}${n.mtime ? ' · แก้ไข ' + new Date(n.mtime * 1000).toLocaleDateString('th-TH') : ''}</p>
    ${n.path ? `<code>${esc(n.path)}</code>` : ''}
    ${n.path ? '<button id="open">📂 เปิดไฟล์</button>' : ''}
    <h4>เชื่อมกับ ${nb.length} อย่าง</h4><ul>${rows}</ul>`;
  $('#info').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => focus(data.nodes.find((x) => x.id === li.dataset.id))));
  $('#open')?.addEventListener('click', () => openFile(n));
  refresh();
}

function refresh() { Graph.nodeColor(Graph.nodeColor()); }

function focus(n) {
  if (!n) return;
  const d = 80, r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
  Graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 1500);
  select(n);
}

async function openFile(n) {
  if (!n.path) return;
  try { await api('/api/open', { method: 'POST', body: JSON.stringify({ id: n.id }) }); toast('เปิดแล้ว: ' + n.name); }
  catch (e) { toast(e.message); }
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2500); }

// ค้นหา
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const hits = q ? data.nodes.filter((n) => n.name.toLowerCase().includes(q) || (n.path || '').toLowerCase().includes(q)).slice(0, 12) : [];
  $('#hits').innerHTML = hits.map((n) => `<li data-id="${esc(n.id)}"><i style="background:${COLORS[n.cat] || '#fff'}"></i>${esc(n.name)} <span>${esc(n.machine)}</span></li>`).join('');
  $('#hits').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { focus(data.nodes.find((x) => x.id === li.dataset.id)); $('#hits').innerHTML = ''; }));
  highlight = new Set(hits.map((n) => n.id)); refresh();
});

// หมุนอัตโนมัติ
let spin = true, angle = 0;
setInterval(() => {
  if (!spin) return;
  const p = Graph.cameraPosition(); const dist = Math.hypot(p.x, p.z) || 600;
  angle += 0.002;
  Graph.cameraPosition({ x: dist * Math.sin(angle), z: dist * Math.cos(angle) });
}, 16);
$('#spin').addEventListener('click', () => { spin = !spin; $('#spin').classList.toggle('on', spin); });
$('#spin').classList.add('on');
$('#graph').addEventListener('pointerdown', () => { if (spin) $('#spin').click(); });

$('#rescan').addEventListener('click', async () => {
  $('#status').textContent = 'กำลังสแกนใหม่…';
  try { await api('/api/rescan', { method: 'POST' }); } catch (e) { toast(e.message); }
  load();
});
$('#reload').addEventListener('click', async () => {
  $('#status').textContent = 'กำลัง sync กับสมองเครื่องอื่น…';
  try { await api('/api/sync', { method: 'POST' }); } catch (e) { toast(e.message); }
  load();
});
api('/api/info').then((i) => {
  $('#me').innerHTML = i.lan ? `ที่อยู่เครื่องนี้: <b>${esc(i.addr)}</b> · รหัส: <b>${esc(i.token)}</b><br><span style="color:var(--dim)">กรอก 2 อย่างนี้ที่คอมอีกเครื่อง</span>`
    : 'เปิดแบบ --local-only อยู่ เครื่องอื่นเชื่อมเข้ามาไม่ได้';
}).catch(() => {});
$('#connectBtn').addEventListener('click', async () => {
  const msg = $('#connectMsg'), btn = $('#connectBtn');
  msg.className = ''; msg.textContent = 'กำลังเชื่อม…'; btn.disabled = true;
  try {
    const r = await api('/api/peers', { method: 'POST', body: JSON.stringify({ url: $('#peerIp').value, token: $('#peerToken').value }) });
    msg.className = 'ok'; msg.textContent = `✅ เชื่อมสำเร็จ! รับข้อมูล ${r.got} เครื่อง ส่งไป ${r.sent} เครื่อง`;
    $('#peerIp').value = ''; $('#peerToken').value = '';
    load();
  } catch (e) { msg.className = 'err'; msg.textContent = '❌ ' + e.message; }
  btn.disabled = false;
});
$('#export').href = '/api/knowledge.md' + (token ? '?token=' + encodeURIComponent(token) : '');

addEventListener('resize', () => Graph.width(innerWidth).height(innerHeight));
load();
setInterval(load, 60 * 1000);
window.Graph = Graph;
