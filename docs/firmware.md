# BW150 USB 固件升级、恢复与离线预演

## 当前刷写规则（2026-11-16 更新）

按用户要求，应用已取消固定 SHA-256、固件文件名型号、AC632N 文件头、BW150 产品 / 版本、刷后序列号和精确 IAP 描述符白名单。Windows / Android 对非空且不超过 **1,024,000 字节**的 `.bin` 文件开放 USB 刷写，与已分析的官方 PC 文件入口一致；不设隐藏开关。SHA-256 和封装系列仅供显示。确认后自动结束当前记录并独占 USB，不再要求先收到停止 / 零输入遥测。设备有效 FF 确认为刷写完成，随后正常应用回读与监测恢复另行报告。CRC、分块序号、回显核对和传输超时继续用于协议完整性。

完整行为、测试和范围见 [刷写规则调整](firmware-open-policy-20261116.md)。下文关于“仅限核准原厂文件”“固定 APP / IAP 版本”“FF 后回读失败即任务失败”等描述属于此前实现及历史硬件验收条件，以本节当前规则为准；历史实机结果不会因软件规则调整而扩大。

更新：2026-11-13（北京时间）。实现位于 `crates/protocol/src/firmware.rs`、`crates/protocol/src/firmware/legacy.rs` 和 `crates/device/src/firmware.rs`。已取得官方程序的一次完整成功传输，并用新应用在 Windows / Android 完成同一台 BW150 的实际升级、FF 确认和正常应用回读。两平台开放这份核准原厂文件的 USB 升级及 IAP 重新传输；Android 已实测从 IAP 直接恢复，以及 APP → IAP → APP 完整升级。Android USB 平台生命周期由 `crates/tauri-plugin-atorch-usb/` 负责。

## 文件与逻辑包

已知 BW150 / BW600 原厂文件使用 AC632N 封装，前 22 字节为 `DC EE BF 1D 30 2E 30 31 F0 31 AC 67 C5 AD FF 68 41 43 36 33 32 4E`。检查要求至少 64 字节，最大 `58 × 65535 = 3,801,030` 字节，并核对该封装。SHA-256、整文件 CRC16、文件名型号、块数和尾块大小一并返回。

AC632N 头和文件名不能证明目标设备型号或固件兼容。文件名仅识别前缀 BW150 / BW600 / DL24 / CW24 / CW20；硬件升级另外要求 SHA-256 精确等于已实测的 BW150 V1.1.0 原厂文件，改名或修改头不能扩大兼容范围。Tauri 入口拒绝路径型文件名、非 bin、过大或无效数据，重选失败会清除旧结果。BW600 文件仍只支持离线预演。

原程序应用态进入 Bootloader 的命令（`0x41c0d0`）为 `55 05 09 02 00 00 00 EE FF`，补零到 64 字节，地址使用广播值 `09`。实机升级在最新的停止 / 零输入回读通过后发送一次；离线预演不发送此命令。回读检查交替发送 03 / 05 只读查询，查询间隔 200 ms、总期限 3 秒，必须同时收到新的参数和遥测；连续紧邻查询在本台 Android 上未取得完整回读时已正确停止于进入 IAP 之前。

以下为不含 USB 外层的逻辑包，所有多字节整数和 CRC 为小端：

| 方向        | 格式                          | 含义                                                 |
| ----------- | ----------------------------- | ---------------------------------------------------- |
| 主机 → 设备 | `AA 07 块数LE16 尾余数 CRC16` | 块数为文件大小除以 58 向上取整；尾余数为 `size % 58` |
| 主机 → 设备 | `CC 长度 序号LE16 数据 CRC16` | 序号从 0 起，数据最多 58 字节；长度为数据字节数 + 6  |
| 设备 → 主机 | `BB 长度 … CRC16`             | 就绪，开始第 0 块                                    |
| 设备 → 主机 | `DD 长度 序号LE16 … CRC16`    | 确认对应分块                                         |
| 设备 → 主机 | `EE 长度 … CRC16`             | 传输结束，等待设备烧写；原程序也允许替代最后一个 DD  |
| 设备 → 主机 | `FF 长度 … CRC16`             | 烧写完成                                             |
| 设备 → 主机 | `11 长度 … CRC16`             | 拒绝 / 失败                                          |

AA / CC 返回缓冲区补零到 64 字节；长度字段只覆盖逻辑内容，不含填充。满块长度 64，数据 58；文件恰好整除 58 时 AA 尾余数为 0，最后块仍为 58 字节。CRC16/Modbus 初值 `FFFF`、多项式 `A001`，计算长度为包长度减去末尾 2 字节，不包含补零；标准向量 `123456789 → 4B37`。

逻辑应答解析核对长度 4–64 和 CRC。实机路径还通过 `legacy::decode` 核对 BB 中的块数 / 余数、DD / EE 中的序号与整块原文件数据，以及实际收到的 CRC 字节。FF 必须为零状态且 CRC 正确，不能用进度达到 100% 替代完成应答。

## 状态与失败处理

状态顺序为 `ready → handshake → transferring → awaitingTransferComplete → writing → complete`。收到 CRC 错误、提前 FF 或错误序号不推进；重复的上一个 DD、首块前重复 BB、等待完成时重复 EE 会忽略。EE 仅可在末块已发送时进入 writing；看到 EE 不能宣布升级完成，仍需 FF。

默认不重发，与原程序静态路径一致。逻辑引擎允许调用方显式配置最多 3 次重试，只重发同一待确认包；普通应答超时 10 秒，等待烧写完成 30 秒，烧写阶段不重发分块。取消仅停止后续逻辑包，不冒充设备支持远程中止、恢复或回滚。拒绝和超时进入失败状态，不自动复位设备或恢复负载。

离线预演在内存中用真实文件构造全部 CC，并由模拟应答核对每块内容、CRC 与序号，再模拟 EE / FF。Tauri 的预演命令只接收文件，不持有设备服务或传输对象，预演结果明确标记 `offline=true`。这证明代码与样本处理一致，不证明真实 Bootloader 行为。

## 已实测的 64 字节 USB 外层

完整成功记录核准了原程序 `0x442a10 → 0x443f00` 的实际行为：每次发送 **64 字节，即 `55 + 逻辑包前 63 字节`**；每次接收 **64 字节，即 `AA + 逻辑应答前 63 字节`**。满 CC / DD 的逻辑长度为 64，58 字节数据全部存在，CRC 只传低字节；较短包的两个 CRC 字节均能容纳。这是观察到的兼容行为，不将补算的 CRC 高字节描述成设备已经发送。解码会逐字节匹配回显与所选原文件，再把已核实的逻辑内容交给序号状态机。

Windows 原生 HIDAPI 另需 `00` 报告 ID 占位，所以本应用向 API 提交 65 字节，其中实际协议报告仍为 64 字节。官方 `hid_write` 的请求长度 64、返回值 65 不能解释为物理传了 65 字节。

| 属性 | 应用态 | IAP 升级态 |
| --- | --- | --- |
| VID / PID | `0483:5750` | `0483:5750` |
| 制造商 | `APP` | `IAP` |
| 产品 | `ATORCH BW150 V1.1.0` | `ATORCH BW150 V1.0.2` |
| Usage Page / Usage | `FF02 / 2` | `FF00 / 1` |
| 本台序列号 | `924415` | `4250313333353108` |

IAP 的输入 / 输出均为 64 字节无编号报告。实测存在两种语义相同的描述符编码，发送 AA 握手前仅精确接受这两份字节：

- Windows HIDAPI 重建形式：`0600ff0901a1010902150026ff007508954081020903150026ff00750895409102c0`。
- Android 通过 GET_DESCRIPTOR 读取的设备原始形式：`0600ff0901a101090216000026ff00750895408102090316000026ff00750895409102c0`。

差异是两处 `LOGICAL_MINIMUM 0` 分别使用 `15 00` 或 `16 00 00`；没有放宽报告大小、Usage、方向或其他字段。Windows 同时检查 Usage；Android 检查 HID class 及双向 64 字节 interrupt endpoint，再直接读取完整 report descriptor。`cargo run -p atorch-device --example usb_profile` 可在 Windows 只读查看当前接口，不发送报告。

本次末块 EE 为 `AA EE 20 4F 2B`、26 字节 `FF` 数据、`AF 4D` CRC，再补零；它代替索引 11087 的 DD。之后 FF 为 `AA FF 06 00 00 D0 31`，再补零。EE 确认数据传完，FF 才确认设备烧写成功。`11` 的真实失败载荷尚未采到；仅将有效 CRC 的 `11` 作为失败，不推测更详细的设备原因。

可用只读工具复核，例如 `python tools/vendor_flow.py 0x442a10 --size 0x800`。原始分析报告在忽略目录的 `fw-start.txt`、`fw-receive.txt`、`fw-timer.txt`、`fw-open.txt`、`fw-send-wrapper.txt`。

## Windows / Android 操作与失败恢复

1. 退出官方 `Load_Application.exe`。停止负载、移除测试输入；停止正在进行的 CSV 录制。
2. 打开“固件更新”，选择 `BW150-6321-APP-1-1-0-UPP.bin`。摘要与已核准文件一致时才出现实机入口。
3. 扫描并选择 BW150 USB 设备。应用态 V1.1.0 可直接升级；已处于 IAP V1.0.2 的设备可直接从第 0 块重新传输，不依赖正常遥测连接。
4. 核对确认窗口中的设备、序列号、文件及 SHA-256 后开始。服务停止并等待原监测线程退出，使用独立的单一传输线程完成 AA / CC，不混入普通查询，也不自动重发。
5. 数据传完后保持供电，等待 EE / FF 和应用态重新枚举。启动于正常应用时还要求序列号保持一致；重新读取参数与停止 / 零输入遥测后恢复只读监测，才显示“升级完成”。

升级期间参数、连接、录制操作会被拒绝，Windows 窗口关闭请求暂不执行。取消只能停止后续分块；末块发送前关闭取消入口，烧写阶段不可取消。取消、超时或断开后可能留在 IAP，重新扫描并选择同一份文件可以重新开始。Android 已从描述符保护停止后的真实 IAP 状态恢复，但没有故意断电或中断数据写入来验证；不提供回滚、自动复位或自动恢复负载。

Android 使用 USB Host，支持普通 OTG，或已启用的可选 Root USB-C 直连；固件不经 BLE 传输。开始前先在连接界面建立 USB 枚举。APP / IAP 切换会产生新的 USB 设备，需及时允许系统 USB 访问（60 秒内）。升级会话跨 APP → IAP → APP 持有可选 Host 角色，避免普通传输对象释放时还原角色；失败后清理，成功后交给正常监测会话，断开监测才还原。升级时保持应用前台，屏幕保持点亮并拦截应用返回；当前没有前台服务保证进程在后台长期存活。

如果已经收到 FF，但应用态未出现或回读失败，任务仍显示失败，并单独标记“设备 FF 完成应答已确认”；不能把这类状态当作完整验收通过。收发日志保存在应用数据目录的 `firmware_logs/`，界面可查看路径。

## 官方抓包与新应用实测记录

| 记录 | 结果 |
| --- | --- |
| `captures/vendor-fw-bw150-20261113.jsonl` | 首轮停在索引 328，329 块；没有 EE / FF |
| `captures/vendor-fw-retry-27788.jsonl` | 第二轮停在索引 5456，5,457 块；官方界面 49.2% 超时；没有 EE / FF |
| `captures/vendor-fw-retry-11208.jsonl` | 精简 HID 挂钩后完成 11,088 块；EE / FF 均存在，官方界面“Burning completed”，恢复正常应用 V1.1.0 |
| `captures/app-firmware-bw150-20261113.jsonl` | 新应用完成 11,088 块、EE / FF，升级后参数保持一致，正常监测恢复，负载停止 |
| `captures/app-firmware-android-bw150-recovery-20261113.jsonl` | Android 从真实 IAP 状态重新传输全部 11,088 块，EE / FF、APP V1.1.0 / 924415、参数保持通过 |
| `captures/app-firmware-android-bw150-20261113.jsonl` | Android 正常应用进入 IAP、完整写入 11,088 块、EE / FF、正常应用回读及参数保持通过 |

前两轮采用了多层 HID / libusb 挂钩。第三轮减少到 HID 读写及开关句柄后成功，因此不能排除抓包开销影响官方时序，但现有记录不能证明它就是唯一原因。官方同时存在普通查询和第二个升级句柄，成功轮也包含另一句柄的重复应答。新应用使用单线程、单句柄并暂停普通轮询。失败发生在不同位置，不据此认定固件某一块损坏。

官方成功轮有效主句柄数据为 11,089 次发送（1 AA + 11,088 CC）、11,090 次有效应答；另一句柄有 102 条重复应答。官方数据显示传输约 50 秒；新应用从启动检查到恢复正常监测为 35,497 ms。二者包含范围与抓包方式不同，不将这一次时长作为性能保证。

Android 实机为 `22061218C` / Android 15，经 Root USB-C Host 直连。IAP 恢复耗时 97,200 ms，正常 APP → IAP → APP 升级耗时 99,335 ms，均包含接口切换、权限等待及应用回读。每轮为 11,089 次 AA / CC 发送、11,090 次 BB / DD / EE / FF 接收，两个完整日志再次逐字节回放通过。报告为 `artifacts/android-firmware-recovery-acceptance.json` 和 `artifacts/android-firmware-acceptance.json`。

Android 第一轮在新的参数 / 遥测检查处停止，未进入 IAP；第二轮进入 IAP 后因设备原始描述符与 Windows 重建形式编码不同而保护停止，未发送 AA / CC。两份失败报告及第二轮原始描述符日志均保留。加入精确实测编码后先恢复 IAP，再执行正常应用入口，没有跳过描述符保护。正常入口验收脚本曾读取上一任务的完成状态提前退出，已改成按新任务 startedAt 区分，并接续观察正在运行的同一任务，未为脚本问题再次刷写。

校验报告为 `artifacts/vendor-firmware-capture-verification.json` 和 `artifacts/windows-firmware-acceptance.json`。官方成功捕获 SHA-256 为 `92dacdbbef6384199db1f4c89517c26a04a7e70ef9df9ef7f1b3ffa0cbde063b`；新应用日志为 `fec0f44a1ad049270bec0cf4bea458ec1c1686f74eb7d782a0cd39b9fce72b38`。源记录与报告均保留在本地忽略目录。

可分别对完整官方记录或本应用日志运行无硬件回放：

```powershell
cargo run -p atorch-protocol --example firmware_replay -- 'Firmware&Software/BW150-6321-APP-1-1-0-UPP.bin' captures/vendor-fw-retry-11208.jsonl
cargo run -p atorch-protocol --example firmware_replay -- 'Firmware&Software/BW150-6321-APP-1-1-0-UPP.bin' captures/app-firmware-bw150-20261113.jsonl
cargo run -p atorch-protocol --example firmware_replay -- 'Firmware&Software/BW150-6321-APP-1-1-0-UPP.bin' captures/app-firmware-android-bw150-recovery-20261113.jsonl
cargo run -p atorch-protocol --example firmware_replay -- 'Firmware&Software/BW150-6321-APP-1-1-0-UPP.bin' captures/app-firmware-android-bw150-20261113.jsonl
```

以上记录均得到 `Complete`、`11088/11088`、匹配发送 `11089`、校验应答 `11090`。`scripts/verify-firmware.mjs` 默认只检查；`--check-official` 检查 Windows 官方程序占用；只有显式 `--flash` 才经界面确认执行已核准本台 BW150 的真实升级。Android 使用 `--android=<ADB_SERIAL>`；Root 直连需显式 `--prepare-usb`，IAP 恢复还需 `--recover --restore-baseline=<保存的升级前报告>`。`--finish-existing=<报告>` 只接续核验原任务，不启动新任务。Windows 验收脚本曾因启动瞬间的 UI 轮询延迟提前退出，后台任务继续成功；使用此参数接续了同一任务及其保留的升级前设置。

## 真实文件的离线验证

| 原厂文件                       | 大小 / 分块 / 尾块                         | AA 握手                |
| ------------------------------ | ------------------------------------------ | ---------------------- |
| `BW150-6321-APP-1-1-0-UPP.bin` | 643,072 字节 / 11,088 块 / 26 字节         | `AA 07 50 2B 1A A2 46` |
| `BW600-6321-APP-2-0-5-UP.bin`  | 712,704 字节 / 12,288 块 / 58 字节，余数 0 | `AA 07 00 30 00 29 6C` |

文件 SHA-256 分别为：

- BW150：`009e6b5c344c26e8d4949293248241fa65d9d053f4577ef17e38569fe8ae99ad`。
- BW600：`9b2f048759d558fd5d83d4a783d2add3f7af2af6edb3a9aca8fb5d86af5767a2`。

Windows 原生 USB 监测和 Android 原生 BLE 监测期间，文件检查和完整预演均通过，采样计数增加、连接 / 设置保持；Android 进程没有重启。空文件、伪造头和不属于已识别封装的原厂 DL24EW-573 文件均被拒绝。报告为 `artifacts/windows-special-firmware.json`、`artifacts/android-special-firmware.json`。

命令行也可显式运行 `cargo run -p atorch-protocol --example firmware -- <BIN路径> [...]` 进行同样的无设备预演。协议单元测试另外覆盖 CRC、精确包字节、尾块、应答顺序、重复 / 错误序号、超时、有限重试、取消与错误文件；UI 覆盖文件切换、过大文件、型号提示和预演结果的离线标识。
