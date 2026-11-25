# 安卓真机和模拟器

安卓适配器连接本机 Appium 的 UiAutomator2 服务。请先在手机里登录大麦、录入常用观演人并打开目标演出。电脑负责读安卓无障碍控件树和发送控件点击，RTX 5060 和 CUDA 均不参与此流程。

## 首次连接

电脑需要 Node.js、Java JDK、Android SDK Platform Tools，以及一部已授权 USB 调试的手机或带大麦 App 的安卓模拟器。Appium 3 要求兼容版本的 Node.js。以下命令适用于首次安装。

```sh
npm install --global appium@3
appium driver install uiautomator2
appium driver doctor uiautomator2
adb devices -l
appium --address 127.0.0.1 --port 4723
```

保持最后一个终端运行。在另一个终端运行本项目。复制 `profiles/android.json` 为自己的本地文件，在主配置里引用它。将 `adb devices -l` 中状态为 `device` 的序列号填到该文件的 `udid`。设置环境变量 `ANDROID_SERIAL` 也可以，它优先于文件。连接时适配器保留已有登录状态和当前页面。

## 映射实际页面

先用 Android SDK 的只读命令查看当前屏幕有哪些可访问控件。控件树可能包含个人信息，保留在自己的设备和本地文件中。

```sh
adb -s SERIAL shell uiautomator dump /sdcard/window.xml
adb -s SERIAL pull /sdcard/window.xml window.local.xml
```

`profiles/android.json` 包含可参考的部分大麦控件 ID，以及需要在当前 App 版本填写的 `replace_...` 项。示例中的详情购买栏、价格列表和购票数量加号来自公开源码可见的控件名称，实际可点击节点和显示文案需要在自己的设备上核对。确认按钮只应指向创建待支付订单的控件。 [安卓控件参考](https://github.com/WECENG/ticket-purchase/blob/3a1c1f11dced9b3f4c2c7e0c2ce005effc9b73ca/damai_appium/damai_app.py#L66)

- `appPackage` 默认是 `cn.damai`。如采用其他平台的官方安卓 App，请复制一份 profile，填入该 App 的包名，再按照其页面分别配置。每次读取都会核对前台包名。未在其他票务平台做实机验证。
- `marker` 用于识别一屏，`login` 要指向可证明当前账号已登录的唯一控件。请选择各页专用的 `marker`，例如报价弹层出现时不会与详情页标记同时可见。若页面同时匹配多个阶段，适配器返回 `unknown`。
- 选择器支持精确匹配 `id`、`text`、`desc`、`class`、`selected`、`checked`、`clickable`、`enabled`。`id` 简写会补上配置包名和 `:id/`。`within` 限定祖先，`has` 限定后代。字段读取可见节点的文字，若为空则读取无障碍描述。
- `choices` 描述选项行。按钮自身显示完整姓名、场次、票档或座位时，仅需 `row` 和 `stateAttribute`。如果姓名、勾选状态、可点击控件在一行的不同子节点，分别填写 `name`、`state` 和 `target`。`stateAttribute` 按控件树里能随选择变化的属性填 `selected` 或 `checked`。姓名和座位必须精确、唯一。仅有颜色变化、无状态标志或整个座位图只有一个画布的界面无法按此方法可靠选座。
- 点击动作的 `target` 需匹配可见、启用、可点击的节点。`labels` 填写该按钮允许的完整文字或无障碍描述。若标签显示在可点击容器的子节点上，可以为动作配置 `name`。同一动作出现多个可见候选时会停下。
- `checkout.fields.attendees` 和 `seats` 应只读取已经选中的完整姓名或座号，每个选中项对应一个节点。对于可选票档，`session`、`tier` 应读取当前已选值。为缺货、验证码、登录失效配置本机可见的状态标记。
- `orders` 动作可映射为提交后用于查询的只读入口。`orders` 阶段的 `openOrder` 必须是最新订单的唯一详情入口，`order` 阶段应配置订单号、完整购票条件和待支付状态。可从确认回执读取 `submittedOrderId`，或者从订单详情读取含时区的 ISO 8601 创建时间 `createdAt` 以区分旧单。查单无法关联到本次提交时会保留未确认状态，需自行查看订单。

## 验证

先用主程序的只读模式核对登录标记、页面、可选票档、座位和观演人。真实程序通过 Appium 的 W3C 会话读取整屏 XML，点击前再核对包名、页面、字段和控件状态。点击使用限定到指定行与名称的唯一元素。模拟 Appium 服务的回归测试可以在电脑上运行。

```sh
node --test test/android.test.mjs
```

该测试核对会话初始化、模拟勾选、订单回读和陈旧控件拦截。真实 App 的页面版本、样式和购票结果仍需在已登录设备上核实。
