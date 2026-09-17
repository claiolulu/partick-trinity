# SPIKE NOTES — 矢量底图方案摸底

目标：评估把现有的 three.js 自建城市换成矢量底图（Mapbox Standard / MapLibre）之后，
视觉、开发量、可维护性和成本各是什么样，最后给一个迁不迁的结论。

**这份 spike 没有改动 main 上任何一行现有渲染逻辑。** 所有新代码都在 `spike/` 下，
根目录的 `index.html` 原样不动，两个版本可以并排打开对比。

| | 路径 |
|---|---|
| 现有版本 | `/index.html` |
| spike（MapLibre，无需 key） | `/spike/index.html` |
| 阶段 2 探针（Mapbox，需要自己的 token） | `/spike/mapbox.html` |

---

## 阶段 0 · 现有项目摸底

### 技术栈

没有框架、没有构建步骤、没有 `package.json`。整个站点就是一个根目录下的静态 `index.html`
（1439 行），通过 `<script type="importmap">` 从 jsdelivr 直接引 three.js `0.160.1`
的 ES module，浏览器原生跑。

渲染层是**完全自建的 three.js 场景**，不是任何地图库：

| 关注点 | 做法 |
|---|---|
| 投影 | 以 `ORIGIN = {55.8690, -4.3040}` 为切点的局部等距平面，1 场景单位 = 1 米，`-Z` 指向正北（`gp(lat, lon, y)`） |
| 渲染器 | `WebGLRenderer` + `EffectComposer` / `RenderPass` / `SMAAPass` / `OutputPass` |
| 光照 | `HemisphereLight` + `DirectionalLight`（带 `PCFSoftShadowMap` 真阴影）+ 补光 |
| 相机 | `PerspectiveCamera(55°, …)` + `OrbitControls`，站点间走双样条镜头 |
| 材质 | 自定义 `whiteModel()` 抽色：源色只决定明度次序，橙色 `#ed7a19` 是场景里唯一的颜色 |
| 标注 | `CSS2DRenderer` 把红点做成真 DOM，自己做遮挡剔除 |
| 效果 | Fresnel 描边辉光壳、落地扫描环、焦点衰减（非当前地标周边压暗） |
| 平面视图 | 另挂一个 Leaflet 实例（`#flatmap`），画同一份矢量轮廓和路线 |

### 自建模型从哪来

**没有外部模型文件，全部是运行时程序化生成的几何。** 这一点很关键：

- `building-footprints.js`（2.4 MB）—— 默认导出一个 GeoJSON `FeatureCollection`，
  6377 个来自 OSM / Overpass 的真实建筑轮廓，ODbL 1.0。
- `buildMappedGeometry()` 把这些 Polygon / MultiPolygon 就地挤压成带顶点色的
  `BufferGeometry`，手工合并顶点以压住 draw call。
- 非地标的部分合成**一个** mesh（`CITY_MESH`，`name: 'osm-footprint-buildings'`）；
  地标按 `properties.landmark` 分组，每组单独一个 mesh + 一层 rim 辉光壳。
- 高度：优先 `height`，其次 `building:levels`，都没有就按建筑类型估。

也就是说，"自建模型"= OSM footprint + 拉伸规则，**不是手工建的 glTF**。
这对迁移是个好消息：同一份 footprint 换到 `fill-extrusion` 上几乎是平移。

### 数据结构

#### `LANDMARKS[]`（写死在 `index.html` 里，8 站）

```js
{
  id, zh, en, kind,
  lat, lon, rot, anchor,
  cam: { bearing, dist, height, look },   // 观察方位角(度,0=N,顺时针) / 水平距离(m) / 相机高(m) / 注视点高(m)
  kicker,                                  // "STOP 01 · POINTHOUSE QUAY"
  facts: [[label, value], …],              // 4 组
  prose: [html, …]                         // 3 段，含 <strong>/<em>
}
```

加载后会被 `FOOTPRINT_DATA.landmarks[id]` 覆盖坐标，让地标和建筑轮廓同源：

```js
for (const lm of LANDMARKS) {
  const mapped = FOOTPRINT_DATA.landmarks[lm.id];
  if (mapped) { lm.lat = mapped.lat; lm.lon = mapped.lon; lm.rot = 0; lm.osmId = mapped.osmId; }
}
```

#### `building-footprints.js`

```js
{
  type, source, license, attributionUrl, osmTimestamp,
  bounds: [w, s, e, n],
  landmarks: { <id>: { osmId, lat, lon, bounds, outline } },   // 8 个
  features: [ { properties: { osmId, building, name, height,
                              'building:levels', 'building:material',
                              'roof:shape', 'roof:levels', 'building:part',
                              parent, landmark }, geometry } ]  // 6377 个
}
```

`properties.landmark` 是把楼挂到站上的那根线，全库只有 **61** 个 feature 带它：

| stop | features | | stop | features |
|---|---|---|---|---|
| riverside | 1 | | unitower | 18 |
| glenlee | 1 | | station | 9 |
| kelvingrove | 1 | | burghhall | 1 |
| kelvinhall | 1 | | byres | 29 |

#### `street-route-data.js`

```js
{
  type: 'FeatureCollection',
  features: [ { properties: { osmId, kind, name, width }, geometry: LineString } ],  // 5095 条路
  route: {
    order: ['riverside', …, 'byres'],          // 8 站顺序
    legs:  [ { from, to, meters, coordinates } ],  // 7 段
    meters: 5610,
    stops
  }
}
```

### 新方案要对齐的接口

1. **投影**：底图用 Web Mercator，现有场景用局部等距平面。两边都只吃 `[lon, lat]`，
   所以对齐点是**经纬度**，别在中间层转米。
2. **相机**：现有 `cam` 是"相机相对地标的极坐标"，地图相机是 `center/zoom/pitch/bearing`。
   换算见下面"相机换算"一节 —— 这里有两个坑，都踩过了。
3. **建筑标识**：现有是 `properties.landmark === stop.id`。新方案要么用底图的 feature id
   （A 方案），要么继续用自带 footprint（B 方案）。见阶段 2。
4. **路线**：`route.legs[].coordinates` 已经是 `[lon, lat]`，直接就是 GeoJSON LineString，
   零转换。
5. **内容**：`kicker / facts / prose` 原样搬，`prose` 带 HTML，渲染时要留着。
6. **署名**：ODbL 1.0 必须保留，见 `MAP-DATA.md`。底图换成 Mapbox 之后
   **两份署名都要挂**（Mapbox 的 + OSM 的）。

---

## 阶段 2 · 建筑高亮探针 —— 结论：走 B 方案

### 先说清楚验证到了什么程度

⚠️ **我没有跑过真实 Mapbox 的 id 稳定性验证。** 这个沙箱环境里 `api.mapbox.com` /
`cdn.jsdelivr.net` 都被网络策略挡掉（proxy 返 403），而且我不应该、也没有你的 token。
所以"同一栋楼刷新前后 id 是否一致"这个实测，**要你在手机上点一下才算数**。

探针已经写好了，就是 `spike/mapbox.html`，打开就能跑，怎么用见下面。

### 但这个 spike 仍然直接走了 B 方案，理由和 id 稳定性无关

1. **B 方案的成本在这个仓库里几乎是零。** 别的项目选 B 要先去 Overpass 抓一遍 footprint，
   这里 `building-footprints.js` 已经躺了 6377 个真实轮廓，其中 61 个已经按站分好组
   （`properties.landmark`）。B 方案要的数据**已经在仓库里了**，抽出来就能用。
2. **A 方案对地标本来就不好使。** Standard 的 3D 地标是真模型，`feature-state` 对它无效，
   所以必须 `show3dLandmarks: false`。而这条路线八站里有一半（河畔博物馆、大学主楼塔、
   凯尔文格罗夫…）恰恰就是会被做成地标模型的那类建筑。
3. **需求是"只高亮特定几栋"。** byres 站要同时点亮 29 栋排屋、unitower 站 18 栋。
   这是"一组建筑"而不是"一栋建筑"，用自己的一层来管分组，比逐个 id 去底图里捞稳得多。
4. **可控性。** 底图更新是 Mapbox 的事，不归我们管；自带 footprint 的渲染结果只随仓库变。

所以：**`spike/index.html` 用 B 方案，自己一层 `fill-extrusion` 盖在底图建筑上。**

如果你跑完探针发现 id 其实很稳，那 A 方案可以作为"非地标建筑"的简化路径，
但上面第 2、3 条仍然成立，我的建议是不值得为它引入第二套高亮机制。

### 怎么跑探针

1. 打开 `/spike/mapbox.html`（部署后的地址见文末）。
2. 填你的 Mapbox token，或者用 `?token=pk.…` 打开
   —— 读到之后会**立刻从地址栏抹掉**再存进 `localStorage`，不会留在链接里，也不进仓库。
3. 放大到 z16 以上，**反复点同一栋楼**。
4. 用 `z16 / z17 / z18` 按钮换缩放，**在每个 zoom 下都点一次同一栋楼**。
5. 点"重新加载"，回到第 3 步再来一遍。
6. 面板顶部的"结论"会自己给答案。

判定逻辑（已经用 5 组构造样本验过，见下）：同一栋楼的点击按位置聚类（25 m 内算同一个目标），
然后分别比对**跨 zoom** 和**跨页面加载**拿到的 id 集合。只有真的跨过刷新或跨过 zoom，
这一组才计入结论 —— 样本不够时它会说"样本还不够"，不会瞎下结论。

探针同时也在验 A 方案的另一半：每次命中都会对 feature 调
`setFeatureState(feature, { select: true })`，高亮压不上去的话当场就能看出来。

### 关于 `show3dLandmarks`

Standard 的 config 项在不同小版本里改过名字（`show3dLandmarks` / `showLandmarkIcons` …），
所以探针里是**逐个试、试不动就跳过**，并把实际生效的项打到 console 和 toast 上，
不假装全都设上了。跑的时候留意一下那行 `[standard config] 生效: …`。

---

## 阶段 3 · 数据结构

从现有数据源抽出来三个文件，放在 `spike/data/` 下。
生成逻辑是一次性的离线脚本，**没有改动任何源文件**。

### `walk.json`（8.9 KB）

```jsonc
{
  "id": "partick-trinity",
  "title": "PARTICK TRINITY",
  "totalMeters": 5610,
  "license": "ODbL-1.0",
  "stops": [{
    "id": "riverside",
    "order": 1,
    "zh": "河畔博物馆",
    "en": "Riverside Museum",
    "kicker": "STOP 01 · POINTHOUSE QUAY",
    "center": [-4.3061682, 55.8652309],
    "camera": {
      "bearing": 20,        // 镜头朝向（现有 cam.bearing + 180）
      "pitch": 70,          // atan2(dist, height - look)，上限 70
      "distance": 242,      // 相机到注视点的直线距离(米) —— 不是 zoom，见下
      "look": 20
    },
    "building": {
      "osmId": "relation/13348001",   // A 方案备用
      "fids": [1],                    // B 方案：highlights.geojson 里的本地 id
      "bounds": [-4.3077, 55.8647, -4.3050, 55.8658]
    },
    "nextLegMeters": 196,
    "facts": [["落成", "2011"], …],
    "prose": ["<strong>河畔博物馆</strong>坐落在…", …]
  }]
}
```

### `route.geojson`（15.6 KB）

一个整条路线的 `LineString`（`kind: "whole"`）+ 7 条分段（`kind: "leg"`，带 `from` / `to` / `meters`）。
直接来自 `street-route-data.js` 的 `route.legs`，没有重算。

### `highlights.geojson`（64.7 KB）

61 个带 `landmark` 标签的真实 OSM 轮廓，每个带：

```jsonc
{ "id": 1, "properties": { "fid": 1, "stop": "riverside", "osmId": "…", "height": 24.5, "base": 0 } }
```

`fid` 是**这份文件自己发的号**，不依赖底图 —— 这正是 B 方案的关键：
刷新、换 zoom、换底图供应商，它都不会变。

**轮廓做了 0.8 m 外扩。** 高亮层和底图建筑用的是同一份 OSM 几何，墙面完全重合会 z-fighting。
以质心为中心整体放大 0.8 m：40 m 的楼约 2%，肉眼看不出，但足够让高亮壳稳定盖在外面。
这个量级远小于 OSM 轮廓本身的误差。

### 相机换算 —— 两个踩过的坑

**坑 1：镜头宽度不一样。** 现有场景是 `PerspectiveCamera(55°)`，
MapLibre / Mapbox 固定 36.87°，窄得多。一开始直接拿 `distance` 套
`mpp = distance / (1.5 × 视口高)` 算 zoom，结果河畔博物馆**直接顶满全屏**。
修法是先把距离换成"要看到多少米高的画面"：

```js
span = 2 · distance · tan(55° / 2)      // 用源相机的 fov
mpp  = span / usable_px
zoom = log2(156543.03392 · cos(lat) / mpp)
```

**坑 2：zoom 不能写死在配置里。** 同一个 `distance` 在手机和桌面必须换出不同的 zoom，
而且手机下半屏被内容卡盖掉，可用高度只有一半左右。所以 `walk.json` 里存的是
**distance（米）**，zoom 在运行时按当前视口算，横竖屏切换后还会重新对一次镜头。

---

## 阶段 4 · 路线渲染

- `route-casing`（白描边）+ `route-line`（灰）画整条路线，线宽随 zoom 插值。
- `route-active`（橙）只画当前站出发的那一腿，切站时改 filter，走到哪亮到哪。
- 起终点各一个 marker（起 / 终）。
- 路径用的是仓库里已有的 OSM 步行路网算出来的真实路线（5.6 km / 7 段），
  **没有**接 Directions API —— 数据已经在仓库里了，不需要再花这个钱。

## 阶段 5 · 叙事联动

点 chip / 上一站 / 下一站 / 方向键 / 点地图上的楼 → 都走同一个 `select(id)`：

1. `setSelected(上一站, false)` 先清 —— 不清的话会留下两栋橙楼。
2. `setSelected(当前站, true)`，一个站可能对应多个 `fid`（byres 是 29 个）。
3. 改 `route-active` 的 filter。
4. `flyTo` 到换算出来的相机，带 padding（手机上把注视点推到卡片上方那半屏的中间）。
5. 换内容卡，同步 chip 的 `aria-current`，`?stop=<id>` 写进地址栏方便分享。

## 阶段 6 · 自建模型桥接

**这一阶段没做，而且我建议先别做。**

理由：现有项目里根本没有手工模型 —— 所有几何都是 OSM footprint 程序化挤压出来的
（见阶段 0）。真要保留的"自己的模型"其实是**挤压规则 + 白模配色**，
而这套东西 `fill-extrusion` 已经能覆盖八成。

真正会掉精度的只有屋顶：现有版本按 `roof:shape` 做了简化屋顶，河畔博物馆还专门做了折板屋顶，
`fill-extrusion` 一律是平顶。如果河畔博物馆那道锯齿屋顶是这条路线的招牌（我认为是），
那它值得单独用 custom layer 挂一个 three.js mesh 上去 —— 但也就它一个，
不值得为剩下 7 站引入第二套渲染管线。

这件事应该等你看完实机效果再决定，所以留在这里没动。

---

## 阶段 7 · 新旧方案对比

### 已验证 / 未验证

先划清楚线，免得把没跑过的东西当结论用：

**已经在无头 Chromium 里实测过的（`spike/index.html`）**

- 8 站数据全部正确装载并渲染：文案、facts、路线里程、`?stop=` 深链。
- 高亮选中数**精确**：riverside 1、unitower 18、byres 29、burghhall 1，
  且任何时刻只有一个站亮着（切站清理逻辑是对的）。
- 图层装配正确：底图自带 `building` 层被拆掉，5 个自建图层都在，3D 层插在 symbol 层之前。
- 相机换算在手机（390×844）和桌面（1440×900）两种视口下都合理，横竖屏切换会重对镜头。
- 修掉了两个实测才暴露的问题：
  - **单个瓦片取不到就把整块界面盖死**，而且那层提示还挡住了点击 —— 手机信号抖一下就会中招。
    改成只有"样式没加载出来"才算致命，瓦片失败只 `console.warn`，提示层加 `pointer-events:none`。
  - **取景过紧**（fov 换算，见阶段 3 坑 1）。

**没验证的**

- ⚠️ **真实底图的观感完全没看过。** 沙箱里 `tiles.openfreemap.org` 被挡，
  测试是拿一个替身样式跑的，所以截图里只有高亮建筑和路线，没有周边城市。
  **底图好不好看，得你在手机上看。**
- ⚠️ Mapbox Standard 那一页（`spike/mapbox.html`）**一次都没跑起来过** —— 没 token、没网。
  代码是照 v3 Interactions API 写的，并且对 config 项和 `addInteraction` 都做了
  feature-detect + 降级，但**它第一次跑起来就是你跑的那次**。
  它的比对逻辑我用 5 组构造样本单独验过（稳定/跨刷新变/跨 zoom 变/样本不足/多目标分组），
  5 组全中，无报错 —— 但那验的是判定逻辑，不是 Mapbox 的行为。

### 对比

| | 现有（three.js 自建） | spike（MapLibre + OpenFreeMap） | Mapbox Standard |
|---|---|---|---|
| **视觉：建筑** | 白模，带 `roof:shape` 简化屋顶、顶点色、Fresnel 描边 | 平顶 `fill-extrusion`，顶点渐变 | 平顶 + 真实地标 3D 模型 |
| **视觉：光照** | 真阴影（PCFSoft）、焦点衰减、扫描环、bloom | **无阴影**（MapLibre 5 没有） | 有光照和阴影，`lightPreset` 可调 |
| **视觉：范围** | 只有 bbox 内 6377 栋，外面是空的 | 全球，缩出去还有东西 | 全球，且更精致 |
| **视觉：可控性** | 完全可控，每个像素都是自己的 | 底图归供应商，只能调色 | 同左，config 项多一些 |
| **首屏体积** | three.js + 2.4 MB footprint + 1.3 MB 路网 ≈ **4 MB+** | maplibre ≈ 900 KB + 数据 90 KB ≈ **1 MB** | mapbox-gl ≈ 800 KB + 数据 90 KB |
| **代码量** | 1439 行，其中 ~900 行是渲染管线 | **~330 行**，没有渲染管线 | 同量级 |
| **移动端** | WebGL 自建场景，低端机压力大 | 底图库自己管 LOD 和瓦片 | 同左 |
| **要维护的东西** | 投影、材质、几何合并、后期、遮挡剔除、Leaflet 平面视图 | 只有数据和联动逻辑 | 同左 + token 轮换 + 用量监控 |
| **署名** | OSM ODbL | OSM ODbL + OpenFreeMap | OSM ODbL + **Mapbox（不可去除）** |
| **key** | 不需要 | **不需要** | 需要，且静态站点没法藏 |
| **费用** | 0（自己的静态托管） | 0 | 按 map load 计费 |

### 费用

不写具体单价 —— Mapbox 的定价这两年改过几轮，我这边的记忆不可靠，
**请按 https://www.mapbox.com/pricing 的当前费率自己代一下**。要代的量是这个：

```
月成本 ≈ max(0, 月 map load 数 − 免费额度) × 单价
```

`map load` = 每 `new mapboxgl.Map()` 一次。注意几个容易低估的地方：

- 探针页每刷新一次就是一次 load，跑阶段 2 的时候别挂着不管。
- 如果以后做成"每站一个 Map 实例"，一次访问就是 8 次 load —— 别这么干，复用同一个实例。
- 预览环境、CI 截图、爬虫都算。

MapLibre + OpenFreeMap 这条路这一项直接是 **0**，
代价是 OpenFreeMap 是免费公共服务，SLA 靠自觉（真要上生产可以自己托瓦片，
或者换 Protomaps 之类，仍然比按 load 计费便宜）。

### 建议：**混合，而且先别急着迁**

1. **短期先别动 main。** 现有版本的视觉质量（真阴影 + 焦点衰减 + 屋顶）确实比
   `fill-extrusion` 高一档，这是它现在最大的资产。在你亲眼看过 spike 的实机效果之前，
   任何"全量迁移"的决定都是拍脑袋。
2. **先去手机上跑两件事**：
   - `/spike/index.html` —— 看真实底图下的观感，以及低端机上的流畅度。
   - `/spike/mapbox.html` —— 跑完阶段 2 的 id 验证，把结论补回这份文档。
3. **如果观感能接受**，我倾向**混合**而不是全量迁移：
   - 底图 / 周边城市 / 路线 → 交给矢量底图，省掉 ~900 行渲染管线和 3.7 MB 数据。
   - 河畔博物馆那道锯齿屋顶（可能再加大学主楼塔的尖顶）→ custom layer 挂 three.js，
     保住招牌。
   - 高亮继续走 B 方案，`highlights.geojson` 已经就位。
4. **底图选 MapLibre + 自托管瓦片，而不是 Mapbox**，除非你明确需要 Standard 的
   真实地标模型和阴影。理由是这是个静态站点：Mapbox token 没地方藏，
   URL 白名单只能防君子，而按 map load 计费的东西挂在公网上是个持续的风险敞口。
   省下来的钱是次要的，**不用管 token 才是主要的**。
5. **如果最后决定全量迁移**，阶段 6 的 custom layer 是唯一的硬骨头，
   其余部分 `spike/index.html` 已经跑通了。

---

## 附：这份 spike 动了什么

**只加，没改。** 新增：

```
SPIKE_NOTES.md              ← 这份文档
.gitignore                  ← .env / node_modules / .DS_Store
.env.example
.github/workflows/pages.yml ← GitHub Pages 部署
spike/index.html            ← MapLibre 版（阶段 1/4/5）
spike/mapbox.html           ← Mapbox 探针（阶段 2）
spike/README.md
spike/data/walk.json
spike/data/route.geojson
spike/data/highlights.geojson
```

根目录的 `index.html`、`building-footprints.js`、`street-route-data.js`、`MAP-DATA.md`
**一个字都没动**，`git diff` 可查。

---

## 数据来源与许可

`spike/data/` 下三个文件全部派生自 `building-footprints.js` 和 `street-route-data.js`，
所以继承同一份许可：

> © OpenStreetMap contributors，Open Database License (ODbL) 1.0
> https://www.openstreetmap.org/copyright — 数据快照 2026-09-07T06:25:20Z

详见 `MAP-DATA.md`。底图署名由各自的地图库自动挂出，**不要去掉**。

---

## 部署

GitHub Pages，workflow 在 `.github/workflows/pages.yml`，推到 `main` 或本 spike 分支就部署。

> ⚠️ **需要仓库 owner 先手动开一次 Pages**（只此一次）：
> **Settings → Pages → Build and deployment → Source 选 “GitHub Actions”**
>
> 首次部署失败在这一步上：
> ```
> Create Pages site failed. Error: Resource not accessible by integration
> ```
> `enablement: true` 本来是想让 workflow 自己开，但创建 Pages 站点属于仓库管理操作，
> Actions 的 `GITHUB_TOKEN` 没这个权限。开过之后重跑 workflow 就行。

开好之后的地址：

| | |
|---|---|
| 现有版本 | `https://claiolulu.github.io/partick-trinity/` |
| spike（手机上看这个） | `https://claiolulu.github.io/partick-trinity/spike/` |
| 阶段 2 探针 | `https://claiolulu.github.io/partick-trinity/spike/mapbox.html` |
