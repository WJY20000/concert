# 在本机核对页面映射

先把目标页面手动打开，选择要验证的票务平台配置。网页配置需要先填实际 HTTPS 域名、路径和用于区分演出的查询参数。安卓配置需要填实际包名和设备序号，启动本机 Appium 并把购票 App 放在前台。选择网页或安卓时，使用你在配置中登记的 provider 名称。

```sh
node src/inspect.mjs config.local.json --provider damai --platform web
node src/inspect.mjs config.local.json --provider damai --platform android
```

命令通过终端逐行读取查询。每行按回车执行。输入 `:status` 会得到当前识别的页面、登录标记、可读字段名称和控件数量。输入 `:quit` 会断开会话。输出只包含状态、计数和字段名称。登录、进入下一页和勾选状态的变化需要你在页面上操作。

### 网页

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
