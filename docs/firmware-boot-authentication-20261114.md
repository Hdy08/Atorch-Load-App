# 固件启动程序与认证路径深入检查（2026-11-14）

检查日期：2026-11-14，北京时间（UTC+8）。本文补充 [固件签名静态检查](firmware-signature-inspection-20261114.md)，记录对 BW150 V1.1.0、BW600 V2.0.5 包内 `uboot.boot`、官方 BD19 参考 ROM 及官方 Bootloader SDK 的进一步分析。使用本地固件副本和公开 SDK，下载内容、解压内容及指令模拟均在电脑内存中处理，没有向设备发送命令或刷写固件。

2026-11-15 补充：全部 10 份不同内容的 AC632N 包已完成启动程序解压，去重为 3 个家族，并继续核对官方 PC 的文件检查入口、参考 ROM 的正常加载链，以及 HID 升级保留启动区、最后补写应用区首块的数据流。此前的部分指令解码限制也已收窄。新证据、复核脚本及剩余边界见 [现有资料核查汇总](firmware-authentication-audit-20261115.md)；本文保留 2026-11-14 当轮的两份样本范围和结论。

## 本轮结论

1. **外部字典限制已经解除。** 找到杰理官方 BD19 `rom.image`，两份启动程序均成功解压，输出长度与压缩头声明一致。另一官方 SDK 的 `rom.lst` 与字典全部 28,672 字节逐字节一致。
2. **已确认实际存在的完整性检查。** 包内启动程序会检查 Flash 头和文件目录头的 CRC；USB 升级握手会检查 CRC16/Modbus、块数，并在接收数据时检查块序号。具体覆盖范围见下文，不能笼统写成“所有接收数据都验过 CRC”。
3. **ROM 的 `doe` 已被确认为 16 位参数驱动的异或数据流变换。** 对其原始指令进行 288 组纯内存模拟，全部与本地 JL ENC 实现一致。该函数本身没有执行厂家公钥验签。
4. **两份样本的 `CC` 分支绕过了随后用于 `AA` 握手的 CRC 检查。** 在已追踪的 `CC` 接收路径中，没有定位到对该接收包 CRC 的重新计算和比较；生成 `DD` 应答的 CRC 与接收 CRC 核验是不同操作。这是文件静态分析结果，未用错误 CRC 包做实机试验。
5. **尚未取得厂家数字签名验证的证据。** 已确认的检查属于包结构、CRC、解码参数、传输顺序和容量限制。在已识别的完成路径中，没有发现“使用可信厂家公钥验证固件签名后才返回 `FF`”的步骤；不能据此证明实物芯片 ROM、驻留 IAP 或其他执行路径完全没有认证。

本轮没有修改应用的固件白名单、协议、安装包或设备行为。当前测试设备的硬件身份由用户确认为 DL24；本文的 BW150 / BW600 名称指所分析的固件包，不构成 PCB、芯片修订或实物型号鉴定。

## 资料来源与可复核摘要

官方 Bootloader 仓库固定到提交 `ff3b9299d1b94d834b995fd858b3f75e2faa9840`，以下文件均从该提交读取：

- [BD19 ROM 字典 `rom.image`](https://github.com/Jieli-Tech/fw-Bootloader/blob/ff3b9299d1b94d834b995fd858b3f75e2faa9840/user_boot/cpu/bd19/output/rom.image)。
- [ROM 导出符号 `maskrom_stubs.ld`](https://github.com/Jieli-Tech/fw-Bootloader/blob/ff3b9299d1b94d834b995fd858b3f75e2faa9840/user_boot/cpu/bd19/output/maskrom_stubs.ld)。
- [Bootloader 库 `uboot.a`](https://github.com/Jieli-Tech/fw-Bootloader/blob/ff3b9299d1b94d834b995fd858b3f75e2faa9840/user_boot/include_lib/liba/bd19/uboot.a)。
- [SDK 启动入口 `main.c`](https://github.com/Jieli-Tech/fw-Bootloader/blob/ff3b9299d1b94d834b995fd858b3f75e2faa9840/user_boot/app/src/main.c)。

独立交叉核对使用 `Jieli-Tech/fw-AC63_BT_SDK` 提交 `fdc018de81629e21e594d677cf05f87d288be0f0` 中的 [BD19 `rom.lst`](https://github.com/Jieli-Tech/fw-AC63_BT_SDK/blob/fdc018de81629e21e594d677cf05f87d288be0f0/cpu/bd19/tools/rom.lst)。从该反汇编文本恢复地址 `0x100000–0x106FFF` 的原始字节，与 `rom.image` 比较：覆盖 28,672 字节，相同 28,672 字节，不同 0 字节。这验证了两个公开资料中的 ROM 内容相同，尚未验证实物设备的 ROM 版本。

| 对象                     |  字节数 | SHA-256                                                            |
| ------------------------ | ------: | ------------------------------------------------------------------ |
| 官方 BD19 `rom.image`    |  28,672 | `d56d4b502e2fe05c337822daa87b153a38d5949c53cca6e75b5739b7276b93a8` |
| 官方 BD19 `uboot.a`      | 275,728 | `c70f261fcfcf9c80f57cfd12028253453afa5f9b407c146c1b8a6b18964c2802` |
| BW150 已解码 BANKCB 文件 |  15,612 | `f0d1d1d9f7eb970ecba7a6755007e214874498baa28b69e3642a06cb48bc0515` |
| BW600 已解码 BANKCB 文件 |  15,495 | `7d9b732f4285ad84d622e90abe6e9e239931205d3d7a827d33c80f78c53abe21` |
| BW150 解压后的启动程序   |  20,896 | `6b3bc026105594afeddc78d43fbaba2c055253103a6f18ca8f2e7ac22a7563a0` |
| BW600 解压后的启动程序   |  20,832 | `df9624d0b6a5b9cdc700bb27fd14324bad5fc7f5f693f01bdf8e9e2264d0bad4` |

原始整包摘要沿用前一报告的 F01、F04。这里“已解码 BANKCB”指去掉文件内混淆、仍包含 BANKCB 和 LZ4 头的 `uboot.boot`，与原始整包和解压后程序是三个不同的散列对象。

## 解压及反汇编方法

两份样本均为一个 BANKCB 块：加载地址 `0x2000`，外部字典地址 `0x100000`，字典长度 `0x7000`，临时地址 `0xA000`。分别验证 BANKCB 头和数据 CRC 后，跳过块内 16 字节 LZ4 头，使用官方参考 ROM 解压。

| 项目                    | BW150 V1.1.0 | BW600 V2.0.5 |
| ----------------------- | -----------: | -----------: |
| 不含 LZ4 头的数据流长度 |       15,580 |       15,463 |
| 头部声明的输出长度      |       20,896 |       20,832 |
| 实际输出长度            |       20,896 |       20,832 |
| BANKCB 头 / 数据 CRC    |       均通过 |       均通过 |

使用已有 `pypcode` 和 `ghidra-jieli` 的 q32s 指令定义，按 `0x2000` 加载地址反汇编，并将 ROM 调用地址与官方 `maskrom_stubs.ld` 对照。指令定义有未覆盖的编码，线性扫描也会遇到内嵌数据和跳转表；本报告只将已核实的指令片段、明确的比较 / 跳转和受控指令模拟作为肯定证据，不把线性反汇编当成所有路径均已覆盖。

官方 `uboot.a` 的多个成员保存 LLVM bitcode。用本机已有 Android NDK 的 `llvm-dis.exe - -o -`，通过标准输入 / 输出在内存中还原 `dec.o`、`jlfs.o`、`sfc_boot.o`、`upgrade.o`、`efuse.o` 的 IR。可看到 `jlfs_mount`、`jlfs_check_all_head`、`jlfs_dual_bank_check`、`get_chip_key` 等函数及调用。它们用于辅助解释样本中的相同操作模式，**没有将官方参考库当成 ATORCH 此版本的完整源码，也没有宣称二者逐函数二进制相同**。

## 启动时到底检查什么

以下地址均为 **BW150 解压后程序按 `0x2000` 加载的地址**，不是原始 `.bin` 文件偏移，也不是官方 PC 程序地址。

| 位置               | 已核实操作                                                                                                        | 能支持的判断                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `0x3D60–0x3D94`    | 读取 32 字节 Flash 头，以 `FFFF` 和偏移 0 调用 `doe`；对头部后 30 字节调用 `chip_crc16`，与头部保存的 16 位值比较 | Flash 头有解码及 CRC 检查；失败跳到 `0x4062`                   |
| `0x3DA8`、`0x3DC2` | 查找 `app_dir_head`、`app_area_head`，检查查找结果                                                                | 目录必须可正确定位；不是产品发布者认证                         |
| `0x3DCC–0x3DD6`    | 比较目录得到的偏移与启动入口传入的偏移                                                                            | 存在布局一致性约束；不等于签名                                 |
| `0x4012–0x4058`    | 按应用基址读取 32 字节目录头，以芯片参数和相对偏移解码，对其中 30 字节复算 CRC；遍历到终止条目                    | 应用目录头逐项检查；不能据此扩展为每个文件全部载荷都已复算 CRC |
| `0x4062–0x4064`    | 将全局启动状态设为 2                                                                                              | 是前述若干错误分支的汇合点                                     |
| `0x4206–0x4208`    | 将启动状态与错误值合并判断，再选择后续分支                                                                        | 结构检查会影响启动 / 升级路径选择                              |
| `0x460E–0x4636`    | 关闭中断、准备传给应用的参数，最后 `call r8`                                                                      | 识别到间接移交应用的路径；没有把所有可能入口都当成已审计       |

官方参考库的 `jlfs_mount` 对应的行为序列是：Flash 头解码和 CRC → 查找两类目录 → 核对布局偏移 → 双 bank 元信息检查 → 应用目录头检查。相关 IR 还表明，双 bank 中使用的若干 CRC 和版本字段参与选 bank；它们不应被误标成厂家签名。

上述结论没有覆盖完整应用载荷的所有访问、ROM 对初级加载块的全部检查或升级时全部临时状态。

## chipkey 的设备侧来源与 ROM 解码函数

前一报告从升级包配置解码出 `0x8D07`。本轮进一步确认，包内启动程序还会读取芯片侧控制器：例如 BW150 的 `0x3864–0x389A`，以及后续文件系统路径中的类似片段，操作 `0x1A18B0–0x1A18B2`，逐字节组合数据，再使用低 16 位。官方 `efuse.o` 中的 `get_chip_key` 具有对应的控制器读取模式。

因此，chipkey 在设备侧并非只取自文件名或明文配置；它可能形成与芯片配置有关的解码约束。但是 **本轮没有读取实物 OTP / eFuse，不能把包中解码出的 `8D07` 直接报告成实物 eFuse 的读取结果**。

官方符号中的 `doe = 0x106F4C` 是跳转入口，实际实现位于 `0x106B44–0x106B87`。根据其指令，等价的数据变换可表达为：

```text
state = (key XOR (relative_offset >> 2)) AND 0xFFFF
for each byte:
    byte = byte XOR (state AND 0xFF)
    state = ((state << 1) XOR (0x1021 if state bit 15 is set else 0)) AND 0xFFFF
```

对这段 ROM 原始指令执行受限解释，只提供寄存器和内存缓冲区，不模拟设备外设。覆盖长度 1、2、7、16、31、32、58、64、257，包含 `0000`、`0001`、`FFFF`、`8D07` 及固定随机参数、多种偏移的 **288 组向量，全部与本地 `jl_enc_cipher` 加相对偏移的结果一致**；共执行 312,048 条被模拟指令。被模拟 ROM 片段的 SHA-256 为 `e30d5f9f3a9fd3903176660dee36da4b7df74fa5cc1e3b99a1ba0e0062096386`。

这是对该解码函数语义的验证。它没有公钥参数、签名输入及验签成功 / 失败结果，不能把它本身称为厂家数字签名认证；也不能由此否定其他函数存在认证。

## USB 升级接收与 FF 的含义

两份包内启动程序都包含与已有抓包对应的 `AA / BB / CC / DD / EE / FF / 11` 处理逻辑。下表保留可以直接核对的两个样本地址：

| 操作                         | BW150 V1.1.0      | BW600 V2.0.5      |
| ---------------------------- | ----------------- | ----------------- |
| 软件 CRC16/Modbus 函数入口   | `0x3530`          | `0x3524`          |
| 遇到 `CC` 时提前转入数据分支 | `0x4C66 → 0x50C6` | `0x4C2C → 0x5084` |
| 随后才识别 `AA` 的指令       | `0x4C6C`          | `0x4C32`          |
| 为接收的 `AA` 复算 CRC       | `0x4C88`          | `0x4C4E`          |
| `AA` CRC 不等时跳过当前处理  | `0x4C9C → 0x52E4` | `0x4C62 → 0x52A2` |
| 数据块序号差必须为 1         | `0x50EE–0x50F0`   | `0x50AC–0x50AE`   |
| 最后阶段调用 Flash 写入函数  | `0x5330 → 0x2E50` | `0x52EE → 0x2DFE` |
| 构造 `FF` 应答               | `0x5348–0x5382`   | `0x5306–0x5340`   |

### 握手、序号和应答校验

BW150 在 `0x4C88` 对 `AA` 包的“长度减 2”字节复算 CRC，并在 `0x4C9C` 与收到的小端 CRC 比较。随后还比较块数与 `0x469F`，超过该路径允许值时构造 `11` 应答。这个 `11` 分支的已确认触发条件是块数限制，不能将所有拒绝都解释为“验签失败”。

CRC 函数的原始指令使用初值 `FFFF` 和反射多项式 `A001`。对 BW150 `0x3530–0x356B` 进行受限指令模拟，使用标准向量 `123456789` 及长度 1–63 的固定随机向量：**64 组全部与 `crcmod` 的 Modbus 实现一致**，标准结果为 `4B37`；共模拟 122,086 条指令。该片段 SHA-256 为 `5866476f913fc123d67b21e105535ac24b6afc2282c302b88b5cad8dc60a6aa7`。这与文件内部 CRC-CCITT 是不同的一层校验。

### CC 接收检查的具体边界

BW150 的关键分支可以直接读成：

```text
0x4C66  收到的命令 == CC  → 0x50C6
0x4C6C  收到的命令 != AA  → 0x52E4
0x4C88  对收到的 AA 包计算 CRC16/Modbus
0x4C9C  CRC 不等          → 0x52E4

0x50C6  检查此前握手状态
0x50EE  计算本块序号与已接收序号的差
0x50F0  差值不是 1       → 0x52E4
```

`CC` 数据分支从第一条跳转离开，因此没有执行这段 `AA` CRC 检查。在已追踪的 `CC` 正常接收、缓冲和写入路径中，见到的 CRC 调用用于生成 `DD / EE / FF` 应答，尚未定位到收到的 `CC` 包 CRC 与重新计算值之间的比较。

这支持“不能声称设备已逐包核验 CC 接收 CRC”的结论。**没有向实机提交损坏 CRC 或修改后的固件，也没有将静态路径推断写成实机接受任意数据的证明。** 主机端仍可验证应答 CRC、序号和回显数据，故不能进一步把这一局部发现概括成“整个升级过程没有传输保护”。

### FF 表示哪一步完成

在识别的 BW150 路径中，数据接收结束后先发送 `EE`，随后处理剩余缓冲，调用写入函数补写暂存的首段，再构造 `FF` 并给 `FF` 包计算 CRC。BW600 有相同操作结构。

在上述完成路径中没有识别出厂家公钥、签名块、对整包作密码散列后验签的调用，或写后读取整包并比较摘要的步骤。这里的 `FF` 是程序报告写入流程到达完成阶段，**不能单独证明厂家验签通过、物理 Flash 全部写入正确、硬件适配或应用正常启动**。原有升级文档要求完成后重新枚举并核对应用回读，仍有必要。

## 数字签名检查的新证据与保留项

两份解压后程序均未匹配前一报告中列出的 PEM / CMS / RSA / EC / Ed25519 容器标识；常见的 `rsa`、`ecdsa`、`ed25519`、`signature`、`certificate`、`public_key`、`sha256` 字符串也没有匹配。按前一报告相同边界扫描 DER SEQUENCE，两份程序各有 1 个候选，均不能解析为有效 X.509 证书。字符串或标准容器缺失本身不是否定证明。

官方参考 ROM 确实导出了 `sha256Compute`、`uECC_compute_public_key`、`uECC_valid_public_key`、`uECC_make_key`、`uECC_shared_secret` 等接口。**存在 SHA / ECC 服务不代表固件启动时使用了它们，更不能把共享密钥协商接口当成签名验证接口。** 在本轮已识别的包内启动代码中，没有定位到对这些入口或 `_sdk_mkey_lock`、已命名 hash 接口的直接调用 / 明确立即数引用。由于有间接调用、未识别编码和 ROM 内部其他路径，不能把这个负面发现升级成全路径无认证证明。

还未解决的边界：

- 未从实物读取 ROM、OTP / eFuse、`key_mac` 所指的设备预留区；官方参考字典相符不等于实物 ROM 修订已核实。
- 未证明升级包内 `uboot.boot` 与实机当前驻留 IAP V1.0.2 的完整代码逐字节相同；USB 协议结构相同也不足以替代该证明。
- 未完成 ROM 从复位到加载 BANKCB 的全部可达路径、所有间接调用和自定义算法的形式化覆盖。
- 未取得可信厂家公钥，没有执行“指定算法、指定签名数据、指定覆盖范围”的厂家验签。
- 未执行设备拒绝实验，未补充新的实机刷写或抓包结论；原有跨型号试验只能支持其实际记录的现象。

## 最小解压复核示例

以下示例使用本地已有 BW150 BANKCB 提取文件，仅在内存中解压。需要 Python `lz4` 包；执行时应位于仓库根目录。它复核解压和摘要，不执行本报告中的控制流分析或指令模拟，也不是数字签名验证器。

```python
from pathlib import Path
import hashlib
import struct
import urllib.request
import lz4.block

commit = "ff3b9299d1b94d834b995fd858b3f75e2faa9840"
url = (
    f"https://raw.githubusercontent.com/Jieli-Tech/fw-Bootloader/{commit}/"
    "user_boot/cpu/bd19/output/rom.image"
)
rom = urllib.request.urlopen(url, timeout=30).read()
assert len(rom) == 28672
assert hashlib.sha256(rom).hexdigest() == (
    "d56d4b502e2fe05c337822daa87b153a38d5949c53cca6e75b5739b7276b93a8"
)
boot = Path("artifacts/vendor-bw150-firmware/top/uboot.boot").read_bytes()
count, size, load, offset, data_crc, header_crc = struct.unpack_from("<HHIIHH", boot)
assert count == 1 and load == 0x2000
bank = boot[offset:offset + size]
dictionary_size, dictionary_addr, temporary_addr, output_size = struct.unpack_from(
    "<IIII", bank
)
assert dictionary_size == len(rom) and dictionary_addr == 0x100000
program = lz4.block.decompress(bank[16:], uncompressed_size=output_size, dict=rom)
assert len(program) == output_size == 20896
assert hashlib.sha256(program).hexdigest() == (
    "6b3bc026105594afeddc78d43fbaba2c055253103a6f18ca8f2e7ac22a7563a0"
)
print(len(program), hashlib.sha256(program).hexdigest())
```

该简例依靠预期 SHA-256 核对输出；BANKCB CRC 的独立复算方法沿用前一报告及本地 `jltech.crc.jl_crc16`。本轮解压时已复算两份样本的 BANKCB 头 / 数据 CRC。ROM 解码和 Modbus 函数的受限模拟只运行电脑内存中的原始指令语义，未执行设备外设访问；352 组向量通过不等于整个启动程序被仿真或实机固件验收通过。
