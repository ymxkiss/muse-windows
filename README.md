# Muse AI Browser

基于 Electron 的 Windows x64 便携式浏览器。可获取clash订阅链接的节点，点击主页可访问https://muse.ai/。

## 功能
1.0.5--首次启动生成一套随机身份、保存后后续启动沿用。目前随机化的是语言、时区、逻辑处理器数、屏幕分辨率和缩放；Canvas、WebGL、Audio、字体等仍未改，所以不能保证完整指纹全新或不可关联。
- 地址栏旁可选择 Clash 订阅节点，或选择“直连（不使用代理）”。支持 Clash YAML 配置中的 `proxies` 节点；应用随附 Mihomo 核心（v1.19.32）处理 Clash 节点协议。所选节点会作为全局代理用于当前浏览器网页流量；节点选择框旁会检测并显示连通状态，点击状态按钮可立即切换为直连。
- Mihomo 仅监听 `127.0.0.1` 本地回环地址；程序不会修改 Windows 系统代理设置。切换为直连时，浏览器恢复直连并停止该代理核心。
- 点击关闭按钮时隐藏到系统托盘；托盘左键单击恢复窗口，右键菜单提供“打开”和“退出”。点击右上角齿轮按钮可隐藏/显示地址栏和节点选择区域；全局快捷键 `Ctrl+Alt+M` 可隐藏/呼出应用窗口。
- 默认发送仿照 Windows Google Chrome 的 User-Agent；可在“订阅管理”窗口的“浏览器设置”中修改。此设置只改变网页读取到的标识，实际浏览器内核仍为随 Electron 打包的 Chromium。
- 网站通过 `target=_blank` 或 `window.open` 请求的新链接会在当前浏览区域打开。
- 可添加、编辑、删除订阅地址，手动更新原始订阅内容，并在文件管理器中定位下载文件。
- 登录 Cookies、网站存储、User-Agent 设置、订阅清单和下载内容均保存在 EXE 同目录的 `MuseBrowserData` 子目录中。

## 从源码运行和打包

需要 Node.js 22 或更新版本：

```bash
npm install
npm start
npm run pack:win
```

打包产物生成在 `dist/`。当前配置输出 Windows x64 portable EXE，不创建安装程序。
