# 在本机核对页面映射

先把目标页面手动打开，选择要验证的票务平台配置。网页配置需要先填实际 HTTPS 域名、路径和用于区分演出的查询参数。安卓配置需要填实际包名和设备序号，启动本机 Appium 并把购票 App 放在前台。选择网页或安卓时，使用你在配置中登记的 provider 名称。

```sh
node src/inspect.mjs config.local.json --provider damai --platform web
node src/inspect.mjs config.local.json --provider damai --platform android
```

命令通过终端逐行读取查询。每行按回车执行。输入 `:status` 会得到当前识别的页面、登录标记、可读字段名称和控件数量。输入 `:quit` 会断开会话。输出只包含状态、计数和字段名称。登录、进入下一页和勾选状态的变化需要你在页面上操作。

### 网页

如果启动日志是 `connected` 后接 `page_unrecognized`，在检查器里输入 `:mapping`。它会列出当前 URL 对得上的阶段，以及每个阶段的 `ready` 和 `login` 分别命中了几个可见元素。正常打开详情页时，`detail.ready` 应为 1，其他候选阶段的 `ready` 应为 0。若 `detail.ready` 是 0 或大于 1，请按实际页面更新 `stages.detail.ready`。如果多个阶段同时命中，请修正这几个阶段的标记，让它们在各自的页面状态中互斥。


在浏览器开发者工具中选中页面元素，检查采用稳定类名或属性的候选 CSS，再把它逐行粘贴到检查器。例如，一个确实使用了原生复选框的确认页可以查询：

```css
input[type="checkbox"]
input[type="checkbox"]:checked
```

`matches` 是 DOM 匹配数，`visible` 是可见匹配数，`enabled` 是可见且可用的匹配数，`selected` 是可见节点中可识别为已选的数量。对只应命中一个节点的按钮或字段，检查其可见匹配数是否为 1。若选座图使用 canvas，查询 canvas 本身只能识别整块画布。逐座自动选择需要网页为座位暴露独立的可定位元素及选中标记。

### 安卓

用 Appium Inspector 查看当前控件树，选取稳定的 resource-id、文字或 content-desc。逐行输入 JSON 对象，例如：

```json
{"text":"提交订单"}
{"class":"android.widget.CheckBox","checked":true}
{"id":"project_detail_perform_price_flowlayout"}
```

`id` 的简写会补全为当前包的 resource-id；安卓适配器只检查该应用的可见节点，因此 `matches` 与 `visible` 相同。若某个文本在页面出现多次，可加入 `within` 限定祖先控件。验证同一行勾选前后的状态变化，确认点击目标自身可用并且配置读取的是同一人的选中状态。若 App 只暴露一块图形画布，需要先手动选座并在确认页核对完整的座位清单。

对详情页、场次票档页、选座页、确认页和已有订单详情页分别操作一次。填写 profile 后再输入 `:status`，然后用 `observe` 核验当前页面和购票目标是否匹配。新票务平台需要独立的 profile 和实机核对。

### 单独校准在售演练场

在正常登录的调试 Chrome 中打开候选演出的详情，先手动选一组有库存的场次和票档。用下面的命令从详情页读取公开字段并生成独立的本机配置。最后一个参数填写 `h5` 或 `desktop`，分别表示 `m.damai.cn` 或 `buy.damai.cn` 的确认页。将示例 ID 换成实际演练场 ID。

```powershell
node .\tools\prepare-rehearsal.mjs 1100435904158 h5
```

工具保留当前配置中的观演人数，将演练文件的开售时间设为空。两个新文件都以 `.local.json` 结尾。确认页的模板选择器仍需和当前页面逐项核对。

进入演练场的确认页后，可以用下列只读命令获取页面结构。输出只包含公开域名与路径、字段附近的元素标签、样式类和勾选状态。姓名由本机配置提供给查找过程，地址栏参数和控件文字不会输出。

```powershell
node .\tools\probe-rehearsal.mjs
```

从**在售演练场的详情页**开始时，可以由探针点击购票入口。它先核对已选场次和票档，再根据本机配置的观演人数调整张数，打开确认页后只采集控件结构。

```powershell
node .\tools\probe-rehearsal.mjs --open 1100435904158
```

若确认页的观演人用自定义图标表示选中状态，可在确认页运行下面的命令。等终端提示后手动勾选一位，输出会显示该行有哪些属性或图标状态发生了变化。命令只读取确认页。

```powershell
node .\tools\probe-rehearsal.mjs --watch-check
```

北京场 H5 确认页已获得自定义勾选框的样例。保持确认页打开，确认张数与本机配置中保存的观演人数一致，再运行下列演练命令。也可以在该场详情页运行，已选场次和票档会沿用。进入确认页后只允许点击观演人，核对勾选和「立即提交」按钮之后结束。

```powershell
node .\tools\probe-rehearsal.mjs --rehearse 1100435904158
```

出现 `rehearsed` 表示到达提交前；`practice_quantity_unverified` 时检查页面张数是否与本机配置人数一致。

### 北京场单次真实提交验证

在调试 Chrome 打开北京陈鸿宇演出 `1100435904158` 的在售详情页，选中 12 月 31 日 20:00 场的 247 元档。本机配置需要包含两位已保存的实名观演人。下面的命令会立即跑完选票和实名勾选，并尝试提交一笔真实订单。此命令专用于北京场。

```powershell
node .\tools\beijing-order-check.mjs --submit-once
```

`submit_click_returned` 表示浏览器已返回提交点击结果。若接着输出 `order_status_unknown`，或页面跳转，请在大麦「我的订单」核对两张票的待支付订单。后续付款由用户在平台完成。
