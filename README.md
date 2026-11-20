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
