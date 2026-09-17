#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   probe-indoor.mjs — 查一条路线上的建筑，OSM 线上到底有没有室内数据

     node spike/tools/probe-indoor.mjs spike/walks/kelvin-way.json

   为什么要单独跑：仓库里那份 OSM 快照只抓了建筑轮廓，
   室内数据（Simple Indoor Tagging）当时根本没进来，所以本地查不出结果。
   这个脚本直接问 Overpass，看线上有没有。

   ⚠️ 要联网。Claude 那个沙箱环境出网被挡，所以必须你本地跑。

   查的是 OSM 的 Simple Indoor Tagging：
     indoor=room|corridor|area|wall|level|corridor
     level=*        楼层号（-1、0、1、1.5…）
     room=*         房间用途
     door / entrance 出入口
   参考：https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';

const ENDPOINT = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error('用法: node spike/tools/probe-indoor.mjs spike/walks/<id>.json');
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// 站点周围多大范围内算"这栋楼的室内"
const PAD_M = 120;
const M_PER_LAT = 110540;
const mPerLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

console.log(`\n▶ 查「${CFG.title || CFG.id}」沿线的 OSM 室内数据`);
console.log(`  endpoint: ${ENDPOINT}`);
console.log(`  每站取锚点周围 ${PAD_M} m\n`);

const report = [];
const failed = [];   // 查失败的站要单独记 —— "没查到"和"没查成"是两回事

for (const stop of CFG.stops) {
  if (!stop.at) { console.log(`  ${stop.id}: 没写 at，跳过`); continue; }
  const [lon, lat] = stop.at;
  const dLat = PAD_M / M_PER_LAT, dLon = PAD_M / mPerLon(lat);
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => v.toFixed(6)).join(',');

  // nwr = node+way+relation 一起查
  const q = `[out:json][timeout:60];
(
  nwr["indoor"](${bbox});
  nwr["room"](${bbox});
  nwr["level"]["building"!~"."](${bbox});
  nwr["entrance"](${bbox});
  nwr["building:part"](${bbox});
);
out tags center;`;

  process.stdout.write(`  ${stop.id.padEnd(14)} 查询中…`);
  let data;
  try { data = await ask(q); }
  catch (e) { console.log(` ✗ ${e.message}`); failed.push({ stop: stop.id, why: e.message }); continue; }

  const els = data.elements || [];
  const bucket = { indoor: [], room: [], level: [], entrance: [], part: [] };
  for (const el of els) {
    const t = el.tags || {};
    if (t.indoor) bucket.indoor.push(t.indoor);
    if (t.room) bucket.room.push(t.room);
    if (t.level !== undefined && !t.building) bucket.level.push(t.level);
    if (t.entrance) bucket.entrance.push(t.entrance);
    if (t['building:part']) bucket.part.push(t['building:part']);
  }
  const n = k => bucket[k].length;
  const uniq = k => [...new Set(bucket[k])].slice(0, 6).join(',');

  const usable = n('indoor') + n('room');
  console.log(` indoor=${n('indoor')} room=${n('room')} level=${n('level')}` +
              ` entrance=${n('entrance')} building:part=${n('part')}` +
              (usable > 0 ? '   ← 有东西！' : ''));
  if (n('indoor')) console.log(`      indoor 取值: ${uniq('indoor')}`);
  if (n('room')) console.log(`      room 取值:   ${uniq('room')}`);

  report.push({ stop: stop.id, zh: stop.zh, ...Object.fromEntries(Object.keys(bucket).map(k => [k, n(k)])) });
  await sleep(1200);   // 别把公共 Overpass 打疼
}

console.log('\n── 小结 ──');

if (failed.length) {
  console.log(`⚠ ${failed.length}/${CFG.stops.length} 个站没查成：${failed[0].why.slice(0, 110)}`);
  if (!report.length) {
    console.log('\n一个站都没查成，所以这次跑下来 什么结论都没有。');
    console.log('不是"没有室内数据"，是"没查到"—— 这两件事别混。');
    console.log('先把网络问题解决（本地跑 / 换 OVERPASS_URL）再来一次。\n');
    process.exit(2);
  }
  console.log('下面的结论只覆盖查成了的那几个站。\n');
}

const anyIndoor = report.some(r => r.indoor + r.room > 0);
if (anyIndoor) {
  console.log('有站点存在室内数据。可以考虑抓下来做剖面/楼层，');
  console.log('但先看覆盖度够不够：几个房间和一整层是两回事。');
} else {
  console.log(`查成的 ${report.length} 个站都没有可用的室内数据。`);
  console.log('这不意外 —— OSM 的室内标注覆盖率很低，主要集中在大型机场、车站、商场。');
  console.log('想做室内就只能：① 自己画　② 找场馆要授权平面图　③ 放弃做真实室内，改做剖面体量。');
}
console.log('\n注意：entrance 和 building:part 不是室内数据 ——');
console.log('entrance 是门的位置，building:part 是外部体量细分（主楼塔那种）。');
console.log('它们能让外观更准，但给不了平面布局。\n');

fs.writeFileSync('indoor-probe.json', JSON.stringify(report, null, 2));
console.log('明细已写入 indoor-probe.json\n');
