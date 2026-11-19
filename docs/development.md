# 开发与构建

项目使用 npm workspaces 和 Cargo workspace。安装 Node.js 22.18 或更新版本及稳定版 Rust。Windows 桌面开发还需要 MSVC C++ Build Tools 和 WebView2 Runtime。

## Windows

```powershell
npm ci
npm run desktop
npm run desktop:build
```

安装包输出至 `target/release/bundle/nsis/`。Windows 设备连接使用系统 HID 驱动。

## Android

已包含 Android 工程，最低支持 Android 8.0（API 26）。配置 JDK、Android SDK 和 NDK 后，从仓库根目录运行以下命令。

```powershell
npm ci
npm run android:dev
npm run android:build
```

通过 USB 连接需要手机支持 USB Host，系统弹窗中应允许访问所选设备。BLE 使用系统蓝牙权限。

## 源码目录

- `apps/app/` 提供 React 界面和 Tauri 原生命令。
- `crates/protocol/` 定义设备报文与解析。
- `crates/device/` 提供设备连接、采样、控制和记录服务。
- `crates/tauri-plugin-atorch-usb/` 与 `crates/tauri-plugin-atorch-ble/` 接入系统 USB 与蓝牙接口。
