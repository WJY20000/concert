# Concert

在自己的 Chrome 购票页或安卓票务 App 上按配置选票。提前在平台登录并保存实名观演人，脚本会核对目标演出、场次、票档、张数、座位和观演人，尝试创建一笔待支付订单。看到 `pending_payment` 后可在原购票端完成付款。

| 入口 | 实现 |
| --- | --- |
| 网页 | Playwright 连接本机已登录的 Chrome。可从详情页、选票页或确认页接手。 |
| 安卓 | Appium UiAutomator2 连接本机真机或模拟器，使用当前 App 的控件树。 |
| 控制台 | 在本机浏览器选择票务平台、购票端和运行方式，查看脱敏时间线。 |
| 其他票务平台 | 在 `providers` 里注册自己的网页域名和页面映射，或安卓包名和控件映射。示例提供大麦配置，其他平台需要各自实测。 |

网页和安卓共用同一套精确匹配、单次提交和订单核验逻辑。本项目独立实现，适配器借鉴了公开源码中可参考的部分控件名称。RTX 5060 和 CUDA 不参与 DOM 或安卓无障碍控件的运行路径。

## 从南京 VICETONE 场开始

需要 Node.js 22 或更高版本。本仓库的网页模板已填入演出 ID `1102631725191`。示例按截图预填了北京时间 2026 年 11 月 26 日 19:00 开售、12 月 4 日周五 22:00 场和早鸟票 88 元。请核对页面实际显示的标题、场次和票档，按需更新 `intent`。本场示例使用非选座票配置及 1 张占位数量，填写本机已保存的观演人姓名后再运行。 [演出详情](https://detail.damai.cn/item.htm?id=1102631725191)

1. 运行 `npm ci`。复制 `config.example.json` 为 `config.local.json`，同时复制选用端的映射文件为 `profiles/web.local.json` 或 `profiles/android.local.json`，再更新主配置里的路径。
2. 在主配置里填写实际场次、票档、张数、精确座号、已保存观演人姓名和待支付页的状态文字。张数要与观演人数一致。非选座票填写 `"seats": []`。选择座位时填完整标签，例如 `"A区3排12座"`。没有同样的座位时脚本会停止。
3. 连接已登录的设备。逐页校准 URL、页面标记和控件选择器。两份映射中的 `replace_` 命名及示例 CSS 需要按实际页面填写。若座位图没有可识别的独立座位节点，可以先手动选座，之后在确认页用脚本核验座位清单。 [网页连接和映射](docs/web.md) · [安卓连接和映射](docs/android.md) · [只读检查工具](docs/inspect.md)
4. 从当前页检查，或在可进入购票流程时演练到可提交状态。演练会操作选票和观演人页面，完成核验后停在提交前。若尚未开放购票，先检查能访问的页面。可先用同类在售项目练习配置。每个项目仍需核对其实际控件。

```powershell
npm start -- observe config.local.json --platform web
npm start -- rehearse config.local.json --platform web
npm run console -- config.local.json
```

安卓使用 `--platform android`。控制台会在终端打印本机访问地址，可在界面切换端和运行方式。 [控制台说明](docs/console.md)

开售时间和页面映射都核对好后，在开售前启动正式运行。若平台允许提前进入确认页，从确认页起步可以少走页面。开售时重新读取页面，操作后立即核验结果。遇到售罄、验证码或选项不符时会停下。

```powershell
npm start -- live config.local.json --platform web
```

日志包含预定开售、首次动作、尝试提交和核实确认的时间。用 `saleToPendingMs` 衡量开售到待支付的耗时。同一配置目录下，同一演出和场次共用 `.concert-state` 下的提交标记。超时或提前停止后，先在平台查看订单。如果确认没有创建订单，确需重试时，再移走对应标记。使用第二个配置目录会跳过原标记。

可在网页映射里增加 `orderLookupUrl` 指向同源的已配置订单列表。提交之后若页面跳到第三方域名，脚本可用新标签页查单，依据订单号或创建时间和明细确认；查单证据不足会报告 `order_status_unknown`。

## 测试

```sh
npm ci
npx playwright install chromium
npm test
```

Linux 若已有 Chromium，可以用 `TEST_CHROMIUM_PATH=/usr/bin/chromium npm test`。GitHub Actions 在 Windows 和 Linux 跑离线 Chromium 页面、模拟 Appium W3C 服务、控制台和订单核验测试。云环境对这场大麦公开页面的访问返回代理 403，安卓真机的实际布局仍需在本机检查。离线运行只测程序操作路径和耗时。
