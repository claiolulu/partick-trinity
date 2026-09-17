# spike/ — 矢量底图方案验证

完整的摸底、结论和新旧对比在仓库根目录的 [`SPIKE_NOTES.md`](../SPIKE_NOTES.md)。
这里只讲怎么跑。

**这个目录不改动 main 上任何现有逻辑，只加文件。** 根目录的 `index.html` 原样不动。

## 两个页面

| 文件 | 是什么 | 要 key 吗 |
|---|---|---|
| `index.html` | MapLibre + OpenFreeMap 的完整 spike：3D 建筑 + 路线 + 建筑高亮 + 叙事联动（阶段 1/4/5） | **不要** |
| `mapbox.html` | Mapbox Standard 的建筑 id 稳定性探针（阶段 2） | 要，自己填 |

## 本地跑

必须走 HTTP，`file://` 下 `fetch('data/…')` 会被 CORS 挡掉。

```sh
npx http-server -p 8080 .        # 在仓库根目录跑
# 然后开 http://127.0.0.1:8080/spike/
```

## `mapbox.html` 的 token

**token 不进仓库。** 这一页要部署到 GitHub Pages，任何写进仓库的 token 都等于公开。
所以它在浏览器里拿 token，两条路：

1. 打开 `spike/mapbox.html?token=pk.xxx` —— 读到之后**立刻从地址栏抹掉**再存进 `localStorage`，
   不会留在链接里，截图和分享都不会带出去。
2. 直接在页面的输入框里填。

建议用一个 scope 只有 `styles:read` / `fonts:read` 的公开 token，并在 Mapbox 后台配 URL 白名单。

> ⚠️ 这一页每加载一次算一次 Mapbox map load，会计费。验完就关。

怎么跑阶段 2 的验证、结论怎么判，见 `SPIKE_NOTES.md` 的「阶段 2」。

## 自定义路线

一条路线 = 一份手写配置 + 一条命令。**不用改任何页面代码。**

```sh
# 1. 抄一份现成的改
cp spike/walks/kelvin-way.json spike/walks/my-walk.json

# 2. 编辑站点（见下面的字段表）

# 3. 生成数据
node spike/tools/build-walk.mjs spike/walks/my-walk.json

# 4. 在 spike/data/walks.json 里加一行，切换器里就会出现
```

然后 `spike/index.html?walk=my-walk`。

### 一个 stop 长这样

```jsonc
{
  "id": "botanic",                       // 英文短名，做 URL 和内部关联
  "zh": "植物园",
  "en": "Glasgow Botanic Gardens",
  "kicker": "STOP 01 · GREAT WESTERN ROAD",
  "at": [-4.28849, 55.87885],            // [经度, 纬度]，相机锚点 / radius 圆心
  "buildings": {                          // 省略 = 这站只飞相机不高亮
    "names": ["Kibble Palace", "Glasshouse"],
    "nameRadius": 400
  },
  "camera": { "bearing": 200, "pitch": 60, "distance": 240, "look": 8 },
  "facts": [["创建", "1817"], …],
  "prose": ["<strong>格拉斯哥植物园</strong>…", …]
}
```

### 选建筑的三种方式（可叠加，取并集）

| 选法 | 用途 | 例子 |
|---|---|---|
| `osmIds` | 精确指定，**最稳** | `["way/26605473"]` |
| `names` | 按 OSM `name` 匹配，不分大小写、支持子串 | `["Kibble Palace"]` |
| `radius` | 以 `at` 为圆心的半径（米），整片点亮 | `130`，配 `minArea` / `maxCount` 过滤 |

想知道某栋楼的 `osmId`，在 `../building-footprints.js` 里搜它的名字。

### 自动推导的东西

- **路线**：在 `../street-route-data.js` 的真实步行路网上跑 Dijkstra，逐段算最短路。
  不连通会退回直线并明确警告。
- **相机**：`camera` 省略时，朝向取行进方向（从上一站望向这一站），
  距离按所选建筑的跨度算。写了就以你写的为准。
- **高度**：优先 OSM `height`，其次 `building:levels × 3.2`，
  再没有就按建筑类型给默认值（温室 7 m、教堂 16 m、大学楼 17 m…）。
  整站强制用一个高度就写 `heightOverride`。

### 已知限制

**公园、广场这类非建筑要素不在数据里。** `building-footprints.js` 只有建筑轮廓，
所以 `kelvinpark` 这站没有橙色高亮，只有相机和内容卡 —— 公园的绿色是底图自己画的。
要把公园轮廓也点亮，得另外从 Overpass 拉一份 `leisure=park` 的面数据。

## `data/`

按路线分目录，每条一套三件套，全部从 `../building-footprints.js` 和
`../street-route-data.js` 离线生成，源文件没动过。

```
data/
  walks.json              路线索引，切换器读这个
  partick-trinity/        8 站 · 5.6 km
  kelvin-way/             5 站 · 3.6 km
```

| 文件 | 内容 |
|---|---|
| `walk.json` | 站点配置：相机（`bearing`/`pitch`/`distance`）、建筑标识、`facts`、`prose` |
| `route.geojson` | 整条路线 + 分腿 |
| `highlights.geojson` | 重点建筑的真实 OSM 轮廓，带自发的稳定 `fid` |

`walk.json` 里存的是**相机距离（米）不是 zoom** —— zoom 在运行时按视口算，
手机和桌面取景才对得上。原因见 `SPIKE_NOTES.md` 的「相机换算」。

## 数据许可

© OpenStreetMap contributors，ODbL 1.0。详见 [`../MAP-DATA.md`](../MAP-DATA.md)。
底图署名由地图库自动挂出，别去掉。
