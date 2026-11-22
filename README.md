# 大麦开售接管脚本

脚本在本机接管你已登录的 Chrome 或 Chromium 标签页，复用现有页面和预填内容。付款由你处理。真实站点的流程未做过端到端测试。

本项目使用原创的 Playwright 浏览器接管代码。当前云环境访问两个官方入口时收到代理 HTTP 403，未能核实有公开文档且当前账号有权调用的正式下单 API。浏览器流程使用正常页面控件。 [大麦](https://www.damai.cn/) · [淘宝开放平台](https://open.taobao.com/)

如果目标演出在桌面浏览器里开放完整购票流程，把确认页作为起点通常更直接。脚本可以提前核验预填内容，等到开售便操作页面。详情页模式会先点进入确认页的按钮，再检查确认页上的预填信息。详情页能提前核验的字段取决于页面上已经显示的内容。若演出只能在 App 中购票、确认页要求临时选择信息，或订单页看不到用于核验的字段，这个桌面流程就无法完整执行。

## 演练

需要 Node.js 22 或更新版本。

```bash
npm ci
npx playwright install chromium
npm test
```

Linux 如果缺少 Chromium 系统依赖，可用 `npx playwright install --with-deps chromium`。已有 Chromium 时也可用 `TEST_CHROMIUM_PATH=/usr/bin/chromium npm test`。

演练使用离线浏览器上下文和虚构域名 `fixture.invalid`，所有请求都由测试进程模拟。运行结果会写入 `test-artifacts/`。GitHub Actions 在推送时运行，也支持手动触发，测试失败会上传测试输出和模拟时间线。

## 本机配置

1. 根据 `config.example.json` 建立 `config.local.json`。示例里的 URL、CSS 选择器和字段值仅用于演示配置结构。用浏览器开发者工具核对实际演出页面后替换它们。
2. 启动一个独立的 Chrome 用户目录，仅绑定本机调试端口。Windows PowerShell 示例：

   ```powershell
   & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "--user-data-dir=$PWD\.chrome-damai"
   ```

   Linux 示例：

   ```bash
   chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$PWD/.chrome-damai"
   ```

3. 在新窗口正常登录并预填，只保留一个匹配该场演出的详情或确认页标签。保持电脑唤醒、系统时间同步，并在开售前运行只读检查：

   ```bash
   npm start -- observe config.local.json
   ```

   日志会显示识别到的页面、核验字段数和按钮状态。只读检查会停在当前页面。需要检查确认页时，先手动打开确认页，再重新运行。
4. 核验通过并准备实际下单时，在开售前运行：

   ```bash
   npm start -- live config.local.json
   ```

### 字段和页面映射

- `saleAt` 使用北京时间和显式偏移，例如 `2027-01-01T10:00:00+08:00`。每场演出使用固定的 `intentKey`。现场使用应始终从同一个工作目录启动。
- `route.path` 是精确的路径，动态订单号可用一个 `:id` 路径段匹配。用 `route.origin` 设置不同的大麦子域名，用 `route.query` 约束演出 ID 等固定参数。若从确认页启动，可删除 `detail`。详情页模式的 `detail.button` 必须是进入确认页的控件。将 `checkout.button` 配置为创建订单的控件。为两者填写可见按钮文案 `buttonTexts`。只有文案精确匹配且控件可用才点击。可用 `soldOutButtonTexts` 单独匹配「缺货登记」一类控件。
- `ready` 和 `login` 应各匹配一个可见元素，并能分别证明页面已加载和登录已生效。`blockers` 用于登录弹窗和验证码，验证码在 iframe 内时可配置其可见外层。`soldOut` 应匹配当前选择的缺货提示。
- `fields` 至少包含演出、场次、票档、数量和观演人。有选座时添加 `seats`，配置期望值和可见字段选择器。字段比较会整理空白字符，然后做精确匹配。若待支付页显示已知的脱敏格式，可给该字段设置 `orderExpected`。无法唯一匹配观演人时，应人工核验订单。
- `orders` 应指向能稳定显示最新订单的只读列表。每行需要可见且唯一的订单号，以及可选的订单详情链接。空列表必须有独立的空状态标记。待支付页必须能读到订单号、待支付状态和全部核验字段。订单列表没有可读取的详情链接时，超时后可能只能报告状态不明。
- 本机配置可能含观演人信息，独立 Chrome 目录保存登录状态。项目已忽略默认的配置文件和浏览器目录。调试端口仅供本机使用。

## 提交、核验和计时

开售前会检查登录与预填内容，读取最近订单作为查重基线。脚本会等待到指定时间，再等待购票控件启用。场次、票档、座位或观演人不符，预填丢失，命中缺货标记或遇到验证码时会停止。

每次流程最多提交一次。提交前创建 `.damai-state/<intentKey>.json`，同目录和同标识的进程会共用这道保护。点击结果不确定时，脚本会查看当前页面及近期订单，只有订单号是新的、状态为待支付、预填字段全部匹配才报告成功。通过列表查到符合条件的订单后，脚本会把详情页留在浏览器里。若仍显示 `order_status_unknown`，请查看大麦订单。只有人工确认这次没有生成订单、确实要重新尝试时，才移走对应的本地标记。运行期间请避免同时通过其他设备为同一演出下单。

日志记录预定开售时间 `saleAt`、首次操作 `firstActionAt`、调用提交点击 `submitAttemptAt`、界面核实待支付订单 `confirmedAt`，以及从开售到确认的差值 `saleToPendingMs`。日志采用 UTC 时间戳。提交时间和确认时间均来自本机观察，实际大麦端耗时仍需在本机现场单独测量。

## 开源实现参考

Stars 来自 2026-11-22 的 GitHub 仓库搜索结果。参考的是网页流程和公开可见的控件行为，提交代码用 Playwright 重新实现。

- Guyungy/damaihelper 有 5,277 Stars，采用 GPL-3.0。它会读取购票按钮上的「即将开抢」「缺货」等状态，并等待确认页。它公开实现中的 `.buy__button` 和 `#dmOrderSubmitBlock_DmOrderSubmitBlock` 可供排查选择器，仍需在实际页面上核对。 [仓库](https://github.com/Guyungy/damaihelper) · [参考源码](https://github.com/Guyungy/damaihelper/blob/4e572664db0303148b3a8f324f8858fffebc8852/ticket_script.py#L126)
- Entromorgan/Autoticket 有 1,448 Stars，采用 MIT。它在进入确认页前也会区分「即将开抢」「立即预订」，并在提交前核对按钮文案。该判断已用于本项目的两段操作。 [仓库](https://github.com/Entromorgan/Autoticket) · [参考源码](https://github.com/Entromorgan/Autoticket/blob/fb370c18174f88a2a8f9cc43ba3216508630b18e/Autoticket.py#L205)
