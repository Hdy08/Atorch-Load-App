# Windows 启动显示目录索引修复（2026-11-16）

用户打开 2026-11-16 的安装版后看到 `artifacts/side-chat-release-20261116/web-dist` 的目录索引，没有应用界面。

## 原因与修复

该次打包使用的临时 `tauri-build.json` 将 `build.frontendDist` 配置为 `D:/Documents/Code/Atorch-Load-App/artifacts/side-chat-release-20261116/web-dist`。Tauri 的 `FrontendDist` 先尝试按 URL 解析，再尝试按目录解析；Windows 盘符形式的字符串被识别为 URL，因而没有嵌入前端资源。仓库常规配置的 `../dist` 正确，错误发生在临时构建覆盖配置。

重新使用仓库常规配置构建 Windows NSIS 安装包，前端入口由程序内置资源提供。`apps/app/src-tauri/build.rs` 增加正式构建检查：使用 Tauri 自身的配置解析器读取基础、平台配置，再合并 `TAURI_CONFIG`；只允许包含 `index.html` 的相对前端目录。外部 URL、Windows 盘符 URL、绝对目录或缺少入口的目录均阻止打包。`tauri dev` 的开发服务器流程保留。

`scripts/check-desktop-assets.mjs` 核验生成的 Brotli 前端资源是否实际存在于 EXE 的字节中，避免仅检查 Vite 构建目录就认定打包成功。该脚本只读 EXE 与编译资源，并可另存 JSON 报告，不启动应用或访问设备。

## 验证与交付

- 原错误覆盖配置被构建检查拒绝，日志包含 `Atorch Load must embed its frontend`。
- 指向缺少 `index.html` 的相对目录也被拒绝。
- TypeScript 检查、Vite 生产构建、Windows release 编译与 NSIS 打包通过；`cargo fmt --all -- --check`、`git diff --check` 通过。
- 新 EXE 实际包含 HTML、主 JS、CSV worker、CSS、SVG 共 5 项压缩资源；修复前已安装 EXE 的对照检查失败，缺少这些资源。
- 从新 EXE 的实际字节提取并解压资源，在无头 Chrome 中渲染，实时监控、数据记录、设备设置、应用设置均可打开，曲线画布可见，无脚本异常，CSV worker 可读取。此项是浏览器渲染验证，不是原生窗口截图验收。
- 新安装包已覆盖本机安装，安装后 EXE 的 5 项嵌入资源核验通过。安装版与独立 EXE 仅有 Tauri 的 3 字节包类型标记不同（`UNK` → `NSS`），其余全部字节一致。
- 已通过正常启动方式打开本机安装版，进程存活，存在标题为 `Atorch Load` 的原生窗口。未执行设备控制或固件刷写。

Windows 窗口检查工具初始化失败，返回 `failed to write kernel assets`。首次独立 EXE 诊断测试未发现调试 WebView，已按失败保留；后续带诊断参数的启动检查被自动审批拒绝，仅返回 `blocked by policy`，未继续该检查。原生窗口的页面内容与截图未取得，未将其记为通过。

交付及日志目录：`artifacts/windows-startup-fix-20261116/`。

| 文件 | SHA-256 |
| --- | --- |
| `Atorch-Load_0.1.0_windows-x64_startup-fix_20261116-setup.exe`（2,770,105 字节） | `8a3385048aef2ea1358070079391f6a8f2096b2b7beeece5b1a50ab836b6aeca` |
| `atorch-app.exe`（独立 EXE，11,540,992 字节） | `9445ce287fcec4153cb813574afaa68615934c8bcfaf3d05ac07c7b95bbfc667` |
| 本机 `C:/Users/Administrator/AppData/Local/Atorch Load/atorch-app.exe` | `35a02a363ad9ace108276502059a4f5d73e4bdac7b9f806c53a257ea47e73677` |

主要验证文件为 `build.log`、`rejected-config.log`、`rejected-missing-index.log`、`asset-check.json`、`old-executable-asset-check.json`、`installed-asset-check.json`、`installation.json`、`normal-launch.json`、`embedded-preview/preview.json` 及 `embedded-preview/startup.png`。

复验资源嵌入时，将当前构建输出的 EXE 和 `out/tauri-codegen-assets` 目录传入：

```powershell
node scripts/check-desktop-assets.mjs <EXE路径> <tauri-codegen-assets目录> <报告.json>
```

此次仅修复 Windows 启动打包问题，未重新生成 Android 安装包。
