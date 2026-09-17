#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   build-walk.mjs — 从一份人写的路线配置生成 spike 要的三个数据文件

     node spike/tools/build-walk.mjs spike/walks/<id>.json

   输入：spike/walks/<id>.json —— 你手写的站点列表（选建筑 + 文案 + 相机）
   输出：spike/data/<id>/walk.json | route.geojson | highlights.geojson

   数据全部来自仓库已有的两个文件，不联网：
     building-footprints.js  6377 个真实 OSM 建筑轮廓
     street-route-data.js    5095 条道路，用来算真实步行路线

   源文件只读，不改。
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ---------- 读现有数据源（它们是 ES module，但我们只要那个默认导出的对象） ---------- */
function loadDefault(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/^[\s\S]*?export default /, '')
    .replace(/;\s*$/, '');
  return JSON.parse(src);
}
const FOOT = loadDefault('building-footprints.js');
const STREET = loadDefault('street-route-data.js');

/* ---------- 几何小工具 ---------- */
const D2R = Math.PI / 180;
const mPerLon = lat => 111320 * Math.cos(lat * D2R);
const M_PER_LAT = 110540;

function dist(a, b) {
  return Math.hypot((a[0] - b[0]) * mPerLon((a[1] + b[1]) / 2), (a[1] - b[1]) * M_PER_LAT);
}
function bboxOf(geom, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  const walk = c => Array.isArray(c[0]) ? c.forEach(walk)
    : (box[0] = Math.min(box[0], c[0]), box[1] = Math.min(box[1], c[1]),
       box[2] = Math.max(box[2], c[0]), box[3] = Math.max(box[3], c[1]));
  walk(geom.coordinates);
  return box;
}
const centroidOf = geom => { const b = bboxOf(geom); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };

/* 方位角：从 a 看向 b，0=正北，顺时针 */
function bearing(a, b) {
  const dx = (b[0] - a[0]) * mPerLon((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_LAT;
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

/* ---------- 建筑高度：OSM 标签 → 米 ---------- */
// 没有 height 也没有 levels 的，按建筑类型给个说得过去的默认值。
// 温室是平的，教堂和大学楼比住宅高 —— 统一给 11 m 会让 Kibble Palace 变成一个方盒子。
const LEVEL_M = 3.2;
const DEFAULT_H = {
  greenhouse: 7, conservatory: 7, hut: 4, shed: 4, garage: 3, roof: 4,
  house: 8, detached: 8, bungalow: 5, terrace: 11,
  apartments: 14, residential: 13, commercial: 14, retail: 11, office: 16,
  church: 16, cathedral: 24, chapel: 12,
  university: 17, college: 15, school: 12, hospital: 18,
  museum: 16, civic: 14, public: 14, train_station: 12, industrial: 10,
};
function heightOf(p) {
  const h = parseFloat(p.height);
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(p['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return lv * LEVEL_M + 1.5;
  return DEFAULT_H[p.building] ?? 11;
}
const baseOf = p => {
  const lv = parseFloat(p['building:min_level']);
  return Number.isFinite(lv) && lv > 0 ? lv * LEVEL_M : 0;
};

/* ---------- 轮廓外扩：避免和底图建筑 z-fighting（见 SPIKE_NOTES） ---------- */
const INFLATE_M = 0.8;
function inflateRing(ring, latRef) {
  const mx = mPerLon(latRef), my = M_PER_LAT;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; n++; }
  if (!n) return ring;
  cx /= n; cy /= n;
  let r = 0;
  for (let i = 0; i < ring.length - 1; i++)
    r = Math.max(r, Math.hypot((ring[i][0] - cx) * mx, (ring[i][1] - cy) * my));
  if (r < 1) return ring;
  const k = 1 + INFLATE_M / r;
  return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}
const inflate = (g, lat) => g.type === 'Polygon'
  ? { type: 'Polygon', coordinates: g.coordinates.map(r => inflateRing(r, lat)) }
  : { type: 'MultiPolygon', coordinates: g.coordinates.map(p => p.map(r => inflateRing(r, lat))) };

/* ═══════════════════════════════════════════════════════════════════════
   建筑选择器 —— 配置里怎么指定"要高亮哪几栋"
     osmIds: ["way/43059928"]        精确指定，最稳
     names:  ["Kibble Palace"]       按 OSM name 匹配（不区分大小写，支持子串）
     radius: 120                     以 at 为中心，半径内所有建筑
     minArea / maxCount              半径模式下的过滤，避免把一整片街区都点亮
   三者可以叠加，取并集。
   ═══════════════════════════════════════════════════════════════════════ */
function selectBuildings(stop) {
  const sel = stop.buildings;
  if (!sel) return [];
  const picked = new Map();
  const add = f => picked.set(f.properties.osmId, f);

  if (sel.osmIds?.length) {
    const want = new Set(sel.osmIds);
    for (const f of FOOT.features) if (want.has(f.properties.osmId)) add(f);
    const got = new Set([...picked.keys()]);
    for (const id of want) if (!got.has(id)) warn(`  ⚠ osmId 没找到: ${id}`);
  }

  if (sel.names?.length) {
    const pats = sel.names.map(n => n.toLowerCase());
    for (const f of FOOT.features) {
      const nm = (f.properties.name || '').toLowerCase();
      if (nm && pats.some(p => nm === p || nm.includes(p))) {
        // 名字可能在全城重名，限制在 at 附近 600 m 内
        if (!stop.at || dist(centroidOf(f.geometry), stop.at) < (sel.nameRadius ?? 600)) add(f);
      }
    }
  }

  if (sel.radius) {
    if (!stop.at) throw new Error(`stop "${stop.id}" 用了 radius 但没写 at`);
    const hits = [];
    for (const f of FOOT.features) {
      const c = centroidOf(f.geometry);
      if (dist(c, stop.at) > sel.radius) continue;
      const b = bboxOf(f.geometry);
      const area = (b[2] - b[0]) * mPerLon(stop.at[1]) * (b[3] - b[1]) * M_PER_LAT;
      if (area < (sel.minArea ?? 0)) continue;
      hits.push({ f, area });
    }
    hits.sort((a, b) => b.area - a.area);
    for (const { f } of hits.slice(0, sel.maxCount ?? 60)) add(f);
  }

  return [...picked.values()];
}

/* ═══════════════════════════════════════════════════════════════════════
   剖面 / 分层体量

   刻意不画房间。把楼按层切成几块水平板，逐层往一个方向错开一点，
   像抽屉拉出来一半 —— 视觉上有"能看进去"的意思，但它明摆着是个示意，
   不假装是平面图。所以既不碰版权，也不用假装精度。

   每层的几何就是同一个 footprint 平移之后的副本，平移量是米。
   不用 fill-extrusion-translate 是因为那个参数的单位是像素，
   会随 zoom 变 —— 楼层错位的距离得是真实的米，不能缩放时自己漂。
   ═══════════════════════════════════════════════════════════════════════ */
function shiftGeom(geom, dx, dy, latRef) {
  const dLon = dx / mPerLon(latRef), dLat = dy / M_PER_LAT;
  const ring = r => r.map(([x, y]) => [x + dLon, y + dLat]);
  return geom.type === 'Polygon'
    ? { type: 'Polygon', coordinates: geom.coordinates.map(ring) }
    : { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(ring)) };
}

function buildCutaway(stop, ownFeatures, center) {
  const cut = stop.cutaway;
  if (!cut) return [];

  // 默认用这一站所有高亮建筑；也可以单独指定（Kibble Palace 就只要它自己）
  let feats = ownFeatures;
  if (cut.buildings) {
    const picked = selectBuildings({ id: stop.id, at: stop.at, buildings: cut.buildings });
    const want = new Set(picked.map(f => f.properties.osmId));
    feats = ownFeatures.filter(f => want.has(f.properties.osmId));
    if (!feats.length) warn(`  ⚠ ${stop.id} 的 cutaway.buildings 没选中任何已高亮的楼`);
  }

  const offset = cut.offset ?? 7;              // 每层往外错多少米
  const brg = (cut.bearing ?? 45) * D2R;
  const ox = Math.sin(brg) * offset, oy = Math.cos(brg) * offset;
  const GAP = cut.gap ?? 0.22;                 // 层间留多少比例的空气
  // 竖向夸张：真实层高只有 1~4 m，而横向要错开好几米，
  // 1:1 画出来会摊成一片而不是一摞。这是示意图，拉高读起来才对 ——
  // 页面上会注明"竖向已夸张"。
  const Z = cut.zScale ?? 1;

  const out = [];
  let slabId = 0;
  for (const f of feats) {
    const latRef = center[1];
    let cum = 0;
    cut.levels.forEach((lv, i) => {
      const h = (lv.h ?? 3.2) * Z;
      const dx = ox * i, dy = oy * i;
      const geom = shiftGeom(f.geometry, dx, dy, latRef);
      slabId++;
      out.push({
        type: 'Feature',
        id: 900000 + slabId,
        properties: {
          kind: 'slab', stop: stop.id, level: i, osmId: f.properties.osmId,
          name: lv.name || `L${i}`, note: lv.note || '',
          base: Math.round(cum * 10) / 10,
          top: Math.round((cum + h * (1 - GAP)) * 10) / 10,
        },
        geometry: geom,
      });
      // 标签点：这一层错开之后的中心
      const b = bboxOf(geom);
      out.push({
        type: 'Feature',
        properties: {
          kind: 'label', stop: stop.id, level: i,
          name: lv.name || `L${i}`, top: Math.round((cum + h * (1 - GAP)) * 10) / 10,
        },
        geometry: { type: 'Point', coordinates: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] },
      });
      cum += h;
    });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   步行路网 + 最短路
   ═══════════════════════════════════════════════════════════════════════ */
// 数据里只有 kind，没有 access 标签，所以这里按类型粗筛。
// motorway / trunk 本来就不在这份数据里（分布是 footway/service/steps/residential/…）。
const NOT_WALKABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

const key = c => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

function buildGraph() {
  const adj = new Map();      // nodeKey -> [[otherKey, meters], …]
  const pos = new Map();      // nodeKey -> [lon, lat]
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, w]);
  };
  for (const f of STREET.features) {
    if (NOT_WALKABLE.has(f.properties.kind)) continue;
    const cs = f.geometry.coordinates;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = key(cs[i]), b = key(cs[i + 1]);
      if (a === b) continue;
      pos.set(a, cs[i]); pos.set(b, cs[i + 1]);
      const w = dist(cs[i], cs[i + 1]);
      link(a, b, w); link(b, a, w);
    }
  }
  return { adj, pos };
}

/* 最小堆，够用就行 */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, p) {
    this.a.push([p, v]);
    let i = this.a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (this.a[j][0] <= this.a[i][0]) break; [this.a[i], this.a[j]] = [this.a[j], this.a[i]]; i = j; }
  }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) { this.a[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let s = i;
        if (l < this.a.length && this.a[l][0] < this.a[s][0]) s = l;
        if (r < this.a.length && this.a[r][0] < this.a[s][0]) s = r;
        if (s === i) break; [this.a[i], this.a[s]] = [this.a[s], this.a[i]]; i = s; } }
    return top[1];
  }
}

function nearestNode(G, at) {
  let best = null, bd = Infinity;
  for (const [k, c] of G.pos) { const d = dist(c, at); if (d < bd) { bd = d; best = k; } }
  return { node: best, snapMeters: bd };
}

function shortestPath(G, from, to) {
  const d = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const h = new Heap(); h.push(from, 0);
  while (h.size) {
    const u = h.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const [v, w] of G.adj.get(u) || []) {
      const nd = d.get(u) + w;
      if (nd < (d.get(v) ?? Infinity)) { d.set(v, nd); prev.set(v, u); h.push(v, nd); }
    }
  }
  if (!d.has(to)) return null;
  const pathKeys = [to];
  while (pathKeys[0] !== from) pathKeys.unshift(prev.get(pathKeys[0]));
  return { meters: Math.round(d.get(to)), coordinates: pathKeys.map(k => G.pos.get(k)) };
}

/* ═══════════════════════════════════════════════════════════════════════
   主流程
   ═══════════════════════════════════════════════════════════════════════ */
const warnings = [];
const warn = m => { warnings.push(m); console.log(m); };

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error('用法: node spike/tools/build-walk.mjs spike/walks/<id>.json');
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(path.resolve(cfgPath), 'utf8'));
console.log(`\n▶ 生成路线「${CFG.title || CFG.id}」，${CFG.stops.length} 站\n`);

/* --- 1. 每站选建筑、定锚点 --- */
const highlights = { type: 'FeatureCollection', features: [] };
let fid = 0;

const resolved = CFG.stops.map(stop => {
  const feats = selectBuildings(stop);
  const own = [];
  for (const f of feats) {
    fid++;
    const latRef = stop.at ? stop.at[1] : centroidOf(f.geometry)[1];
    const feature = {
      type: 'Feature',
      id: fid,
      properties: {
        fid, stop: stop.id, osmId: f.properties.osmId, name: f.properties.name || '',
        height: Math.round((stop.heightOverride ?? heightOf(f.properties)) * 10) / 10,
        base: Math.round(baseOf(f.properties) * 10) / 10,
      },
      geometry: inflate(f.geometry, latRef),
    };
    highlights.features.push(feature);
    own.push(feature);
  }

  // 锚点：优先配置里的 at，其次所选建筑的包围盒中心
  let center = stop.at;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  own.forEach(f => bboxOf(f.geometry, box));
  if (!center) {
    if (!Number.isFinite(box[0])) throw new Error(`stop "${stop.id}" 既没有 at 也没选到任何建筑`);
    center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }
  const span = Number.isFinite(box[0])
    ? Math.max((box[2] - box[0]) * mPerLon(center[1]), (box[3] - box[1]) * M_PER_LAT) : 0;

  console.log(`  ${stop.id.padEnd(14)} ${String(own.length).padStart(3)} 栋` +
    (own.length ? `  跨度 ${Math.round(span)} m` : '  （无建筑高亮）') +
    (stop.cutaway ? `  · 剖面 ${stop.cutaway.levels.length} 层` : ''));
  own.filter(f => f.properties.name).slice(0, 4)
     .forEach(f => console.log(`        · ${f.properties.name}  ${f.properties.osmId}  h=${f.properties.height}m`));

  return { stop, own, center, span };
});

/* --- 2. 路线：在步行路网上逐段算最短路 --- */
console.log('\n▶ 步行路网寻路');
const G = buildGraph();
console.log(`  路网节点 ${G.pos.size}，边 ${[...G.adj.values()].reduce((a, v) => a + v.length, 0) / 2}`);

const snapped = resolved.map(r => {
  const s = nearestNode(G, r.center);
  if (s.snapMeters > 150) warn(`  ⚠ ${r.stop.id} 距最近路网节点 ${Math.round(s.snapMeters)} m，路线起点可能偏`);
  return s;
});

const legs = [];
let total = 0;
for (let i = 0; i < resolved.length - 1; i++) {
  const p = shortestPath(G, snapped[i].node, snapped[i + 1].node);
  if (!p) {
    warn(`  ⚠ ${resolved[i].stop.id} → ${resolved[i + 1].stop.id} 路网不连通，这一段退回直线`);
    const d = Math.round(dist(resolved[i].center, resolved[i + 1].center));
    legs.push({ from: resolved[i].stop.id, to: resolved[i + 1].stop.id, meters: d,
                coordinates: [resolved[i].center, resolved[i + 1].center], straight: true });
    total += d;
    continue;
  }
  legs.push({ from: resolved[i].stop.id, to: resolved[i + 1].stop.id, meters: p.meters, coordinates: p.coordinates });
  total += p.meters;
  console.log(`  ${resolved[i].stop.id} → ${resolved[i + 1].stop.id}：${p.meters} m，${p.coordinates.length} 个顶点`);
}

/* --- 3. 剖面几何（要在 stops 之前算，stops 里要引用它选中的 osmId） --- */
const cutaway = { type: 'FeatureCollection', features: [] };
const cutawayTargets = new Map();
const cutawayCams = new Map();
for (const r of resolved) {
  const feats = buildCutaway(r.stop, r.own, r.center);
  cutaway.features.push(...feats);
  if (!feats.length) continue;
  const slabs = feats.filter(f => f.properties.kind === 'slab');
  cutawayTargets.set(r.stop.id, slabs.map(f => f.properties.osmId));

  // 剖面自己的机位：这一摞板被错开之后，重心和高度都跟原楼不一样了，
  // 沿用原来的相机会拍不全（实测就是顶出画面）。这里按整摞的包围盒重算。
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  slabs.forEach(f => bboxOf(f.geometry, box));
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const spanM = Math.max((box[2] - box[0]) * mPerLon(cy), (box[3] - box[1]) * M_PER_LAT);
  const topM = Math.max(...slabs.map(f => f.properties.top));
  cutawayCams.set(r.stop.id, {
    center: [Math.round(cx * 1e7) / 1e7, Math.round(cy * 1e7) / 1e7],
    // 给页面整摞的包围盒：错开之后这东西是"宽"的，
    // 竖屏手机上决定取景的是宽度不是高度，只给一个 distance 会拍不全（实测就是）
    bounds: box.map(v => Math.round(v * 1e7) / 1e7),
    topM: Math.round(topM * 10) / 10,
    pitch: 52,
    look: Math.round(topM * 0.45 * 10) / 10,
  });
}

/* --- 4. 相机：没写就从路线方向和建筑跨度推 --- */
const stops = resolved.map((r, i) => {
  const c = r.stop.camera || {};
  // 默认朝向 = 沿行进方向看（从上一站望向这一站），第一站用望向下一站的方向
  const auto = i > 0 ? bearing(resolved[i - 1].center, r.center)
             : (resolved[1] ? bearing(r.center, resolved[1].center) : 0);
  const distance = c.distance ?? Math.max(Math.round(r.span * 1.4), 150);
  return {
    id: r.stop.id,
    order: i + 1,
    zh: r.stop.zh,
    en: r.stop.en,
    kicker: r.stop.kicker,
    center: [Math.round(r.center[0] * 1e7) / 1e7, Math.round(r.center[1] * 1e7) / 1e7],
    camera: {
      bearing: Math.round(c.bearing ?? auto),
      pitch: c.pitch ?? 62,
      distance,
      look: c.look ?? 14,
    },
    building: {
      osmId: r.own[0]?.properties.osmId ?? null,
      fids: r.own.map(f => f.properties.fid),
      bounds: r.own.length ? (() => {
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        r.own.forEach(f => bboxOf(f.geometry, b));
        return b.map(v => Math.round(v * 1e7) / 1e7);
      })() : null,
    },
    nextLegMeters: legs[i]?.meters ?? null,
    facts: r.stop.facts || [],
    prose: r.stop.prose || [],
    // 有剖面的站，把层的名字/说明也带进 walk.json，卡片里要列出来
    cutaway: r.stop.cutaway
      ? {
          levels: r.stop.cutaway.levels.map(l => ({ name: l.name, note: l.note || '' })),
          zScale: r.stop.cutaway.zScale ?? 1,
          // 被剖开的那几栋的 osmId：剖面打开时页面要把对应的实心高亮藏掉，
          // 同一站其他没被剖的楼要留着当环境
          osmIds: [...new Set(cutawayTargets.get(r.stop.id) || [])],
          camera: cutawayCams.get(r.stop.id) || null,
        }
      : null,
  };
});



/* --- 4. 写文件 --- */
const whole = [];
for (const leg of legs) for (const c of leg.coordinates) {
  const last = whole[whole.length - 1];
  if (!last || last[0] !== c[0] || last[1] !== c[1]) whole.push(c);
}
const route = {
  type: 'FeatureCollection',
  properties: { meters: total, order: stops.map(s => s.id) },
  features: [
    { type: 'Feature', properties: { kind: 'whole', meters: total },
      geometry: { type: 'LineString', coordinates: whole } },
    ...legs.map(l => ({ type: 'Feature',
      properties: { kind: 'leg', from: l.from, to: l.to, meters: l.meters, straight: !!l.straight },
      geometry: { type: 'LineString', coordinates: l.coordinates } })),
  ],
};
const walk = {
  id: CFG.id, title: CFG.title, subtitle: CFG.subtitle, city: CFG.city || 'Glasgow',
  totalMeters: total,
  source: FOOT.source, license: FOOT.license,
  attributionUrl: FOOT.attributionUrl, osmTimestamp: FOOT.osmTimestamp,
  stops,
};

const outDir = path.join(ROOT, 'spike', 'data', CFG.id);
fs.mkdirSync(outDir, { recursive: true });
const write = (n, o) => {
  const p = path.join(outDir, n);
  fs.writeFileSync(p, JSON.stringify(o));
  console.log(`  ${('spike/data/' + CFG.id + '/' + n).padEnd(42)} ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
};
console.log('\n▶ 输出');
write('walk.json', walk);
write('route.geojson', route);
write('highlights.geojson', highlights);
// 没有任何剖面时也写一个空集合，页面就不用为 404 写特判
write('cutaway.geojson', cutaway);

const slabs = cutaway.features.filter(f => f.properties.kind === 'slab').length;
console.log(`\n✓ ${stops.length} 站 · ${highlights.features.length} 栋高亮建筑` +
  (slabs ? ` · ${slabs} 块剖面板` : '') + ` · 全程 ${(total / 1000).toFixed(2)} km`);
if (warnings.length) console.log(`\n注意 ${warnings.length} 条（见上）`);
console.log(`\n打开：spike/index.html?walk=${CFG.id}\n`);
