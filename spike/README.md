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

## `data/`

三个文件都是从 `../building-footprints.js` 和 `../street-route-data.js` 离线抽出来的，
源文件没动过。

| 文件 | 内容 |
|---|---|
| `walk.json` | 8 站配置：相机（`bearing`/`pitch`/`distance`）、建筑标识、`facts`、`prose` |
| `route.geojson` | 整条路线 + 7 段分腿 |
| `highlights.geojson` | 61 个重点建筑的真实 OSM 轮廓，带自发的稳定 `fid` |

`walk.json` 里存的是**相机距离（米）不是 zoom** —— zoom 在运行时按视口算，
手机和桌面取景才对得上。原因见 `SPIKE_NOTES.md` 的「相机换算」。

## 数据许可

© OpenStreetMap contributors，ODbL 1.0。详见 [`../MAP-DATA.md`](../MAP-DATA.md)。
底图署名由地图库自动挂出，别去掉。
