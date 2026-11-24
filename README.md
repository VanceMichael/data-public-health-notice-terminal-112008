# 冬季服务点公告的分语言终端换页

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。`npm ci` 安装锁定依赖，再用 `npx playwright install chromium` 准备 Chromium。使用 Linux 时需有 Chromium 系统库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可通过 `SOURCE_PORT` 设置端口，也接受通用的 `PORT`，同时设置时以 `SOURCE_PORT` 为准。`GET /health` 用于确认来源服务已就绪。来源使用进程内演练时钟，启动时处于 `primary`。用 `PUT /_source_clock?step=stale` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `primary`、`stale`、`urgent`、`reconnect`、`display`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料，或用浏览器查看入口。

## 来源约定

市级公开页从 `/bulletins` 进入，地方语言页从 `/translation` 进入，屏控站点从 `/screens` 进入。段落卡片上原文号、适用点位、发布时间和生效时间均是业务内容。日期按东八区处理。地方语言页在同一段落同时列出原文段落识别码和所译版号，标明审译状态。
待办入口显示门户当前接收的换页单与设备实际显示的版本。设备组信息中，单页设备支持先将失效的页面切换为应急联系告示，整组设备可以同时启用组内页面。合成值班文件是 `fixtures/desk.json`。

## 浏览器代办（`app/`）

代办只用 Playwright 打开渲染后的可见页面取数、填表，不调用来源服务的内部演练时钟（`/_source_clock`、`/_source_calls`）；后者仅由演练脚本和测试在外部推进、核对。

- `app/clock.mjs`：演练时钟与东八区生效时间判断。
- `app/parse.mjs`：公告段、语言页段、设备组行、待办行的纯函数解析。
- `app/notices.mjs`：通知分类（迁移/停办/复行/更正）与已生效停办点位。
- `app/translation.mjs`：译文核对复用、应急替代、整页合成与预览文本渲染。
- `app/browser.mjs` / `app/portal.mjs`：只读浏览与门户可见界面操作（预览→主管确认码→登记、撤销）。
- `app/agent.mjs`：编排。离线重连先撤销到点旧换页再补登记；同范围新通知整页重建，不混版本。
- `app/state.mjs`：跨阶段状态与凭据持久化（`runs/<run>/state.json`、`evidence/`）。
- `app/report.mjs`：按服务点输出“门户已接收/设备已显示/替代文案仍在使用/需人工上屏”，并追溯原文与译文发布时间。
- `app/cli.mjs`：命令行入口。

### 业务规则要点

- 只复用“原文未变且适用范围未变”的**已审**译文；待审译文只登记缺口，绝不进入发布页。
- 译文缺口先用 `fixtures/desk.json` 的应急文字、再用官方原文暂代，页面文本带 `[应急替代·译文待补]` 等标记。
- 停办生效后，涉事地点、时间不再作为有效服务出现，只保留停办口径与通用联系段，且至少保留应急联系方式。
- 同一段落家族只显示最新已生效版号；新版未到点时继续显示旧版，不提前上屏。
- 设备能力以门户页面说明为准；单页设备逐页换，整组设备由门户表单统一启用。
- 确认只认门户回读的“已显示/撤销已确认”，且换页单号必须在本代办登记基线之后出现，不冒领预置回执。

### 运行

先 `npm start` 起来源，再在另一终端执行：

```sh
node app/cli.mjs run-all                 # 顺序跑 primary→display 五个阶段并出报告
node app/cli.mjs run --phase urgent      # 单跑一个阶段
node app/cli.mjs report --phase display  # 按已有状态重出报告
```

配置样例在 `app/config.example.json`。`sourceClockControl.enabled=true` 时 CLI 会代为推进来源演练时钟；真实部署应关闭它，由外部调度推进阶段，代办本身仍只走公开/可见界面。产物默认写到 `runs/latest/`（已被 git 忽略），其中 `evidence/` 保存每次换页的预览页与登记回执 HTML，供主管核对。
