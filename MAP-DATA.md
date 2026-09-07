# 地图与建筑数据

建筑轮廓来自 © OpenStreetMap contributors，通过 Overpass API 获取。

- 许可：Open Database License (ODbL) 1.0
- 版权与署名：https://www.openstreetmap.org/copyright
- 数据许可：https://opendatacommons.org/licenses/odbl/1-0/
- 数据快照：2026-09-07T06:25:20Z
- 范围：南 55.859，西 -4.338，北 55.881，东 -4.276
- 渲染要素：6377 个建筑或建筑分区（包含 Glenlee 船体）
- 数据文件：building-footprints.js（默认导出的 GeoJSON FeatureCollection）

处理方式：保留源轮廓顶点与内院；合并 multipolygon 成员；已有建筑分区覆盖的母建筑部分不重复绘制。坐标使用与地图底图一致的本地投影。平面视图叠加同一份矢量轮廓，减少底图缓存更新差异带来的视觉误差。

高度优先使用 height，其次 building:levels。缺失高度按建筑类型估算。屋顶按 roof:shape 简化；河畔博物馆为简化折板屋顶。高度、屋顶形状与立面不构成测绘级重建。轮廓精度取决于 OSM 原始数据；地图瓦片可能与矢量快照存在更新时间差异。

请通过本地 HTTP 服务打开 index.html，确保 building-footprints.js 与其位于同一目录。地图瓦片通过浏览器按需加载，未下载或打包地图瓦片。

## 简化底图与路线

道路来自同一范围的 OpenStreetMap highway 数据。底图仅绘制建筑轮廓和道路，不再请求通用地图瓦片。路线按页面八站顺序在允许步行的道路图上计算，排除标注禁止步行或私人通行的路段；站点接入最近的连通路网节点。总长约 5.6 公里，为沿路参考路线，未核实各场馆入口与实时开放情况。道路显示宽度使用按类别估算值。数据文件：street-route-data.js；许可同为 ODbL 1.0。
