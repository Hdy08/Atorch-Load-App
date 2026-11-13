import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Select,
} from "@fluentui/react-components";
import { ArrowUpload20Regular, UsbPlug20Regular } from "@fluentui/react-icons";
import { api, native } from "../lib/api";
import type {
  DeviceInfo,
  FirmwareInfo,
  FirmwareRehearsal,
  Snapshot,
} from "../lib/types";

const phases: Record<string, string> = {
  preparing: "检查设备",
  bootloader: "进入升级模式",
  handshake: "升级握手",
  transferring: "传输固件",
  writing: "等待烧写确认",
  reconnecting: "核对正常应用",
  complete: "升级完成",
  failed: "升级未完成",
  cancelled: "已停止传输",
};

export function FirmwarePanel({
  snapshot,
  busy,
  onTask,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onTask: (task: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const data = useRef("");
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [rehearsal, setRehearsal] = useState<FirmwareRehearsal | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const job = snapshot.firmware;
  const hardware = !!firmware?.hardwareWriteAvailable;
  const selectedDevice = devices.find((d) => d.path === selectedPath);
  const recovery = selectedDevice?.name === "ATORCH BW150 V1.0.2";
  const eligible =
    !!selectedDevice &&
    /^ATORCH BW150 V1\.(1\.0|0\.2)$/.test(selectedDevice.name);
  const otherConnection =
    snapshot.connected && snapshot.device?.path !== selectedPath;
  const startable =
    hardware &&
    eligible &&
    !busy &&
    !scanning &&
    (!snapshot.recording ||
      (snapshot.recordingPaused && snapshot.telemetry?.running === false)) &&
    !otherConnection;
  const scan = async () => {
    setScanning(true);
    setScanError("");
    try {
      const found = (await api.discover()).filter(
        (d) => d.transport !== "bluetooth",
      );
      setDevices(found);
      setSelectedPath((old) =>
        found.some((d) => d.path === old)
          ? old
          : (found.find((d) => d.path === snapshot.device?.path)?.path ??
            (found.length === 1 ? found[0].path : "")),
      );
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    if (hardware && !job?.active) void scan();
    // A new inspected file or a finished job refreshes the USB paths. Ordinary
    // telemetry polling must not repeatedly enumerate or open the bootloader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware, job?.active]);
  const target = snapshot.device?.name.toUpperCase() ?? "";
  const modelMatches =
    !!firmware?.filenameModel && target.includes(firmware.filenameModel);
  return (
    <div className="firmware-layout">
      <Card>
        <div className="section-head">
          <h2>固件检查与升级握手</h2>
          <ArrowUpload20Regular />
        </div>
        <div className="firmware-drop">
          <div className="firmware-file-icon">
            <ArrowUpload20Regular />
          </div>
          <h3>{firmware?.name ?? "选择 AC632N .bin 固件"}</h3>
          <p>
            {firmware
              ? `${firmware.bytes.toLocaleString()} 字节 · ${firmware.blocks.toLocaleString()} 块`
              : "读取原始文件，检查封装、大小、摘要和升级分块。"}
          </p>
          <Button
            disabled={busy || !native}
            onClick={() => fileRef.current?.click()}
          >
            选择固件文件
          </Button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".bin,application/octet-stream"
            data-testid="firmware-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setFirmware(null);
              setRehearsal(null);
              data.current = "";
              void onTask(async () => {
                if (file.size < 64 || file.size > 58 * 65535)
                  throw new Error("固件大小必须在 64 至 3,801,030 字节之间");
                const bytes = new Uint8Array(await file.arrayBuffer());
                let binary = "";
                for (let offset = 0; offset < bytes.length; offset += 8192)
                  binary += String.fromCharCode(
                    ...bytes.subarray(offset, offset + 8192),
                  );
                const encoded = btoa(binary);
                const info = await api.inspectFirmware(file.name, encoded);
                data.current = encoded;
                setFirmware(info);
              });
            }}
          />
        </div>
        {!native && <p>请在 Windows 或 Android 原生应用中执行固件检查。</p>}
        {firmware && (
          <>
            <dl className="firmware-facts">
              <dt>封装系列</dt>
              <dd>{firmware.family}</dd>
              <dt>分块</dt>
              <dd>
                {firmware.blocks} × 最多 58 字节；尾块 {firmware.lastBlockBytes}{" "}
                字节；握手余数 {firmware.remainder}
              </dd>
              <dt>文件 CRC16</dt>
              <dd className="mono">{firmware.crc16}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{firmware.sha256}</dd>
            </dl>
            {snapshot.device && !(modelMatches && hardware) && (
              <MessageBar intent={modelMatches ? "info" : "warning"}>
                <MessageBarBody>
                  {modelMatches
                    ? "文件名型号与当前设备一致；封装头不包含已核准的型号标识，仍需人工核对固件来源与版本。"
                    : "文件名型号与当前设备不匹配或无法识别，请勿用于实机升级。离线预演可检查传输协议。"}
                </MessageBarBody>
              </MessageBar>
            )}
            <details className="firmware-packets">
              <summary>查看握手与首尾分块</summary>
              <p>应用态进入升级模式（预演不会发送）：</p>
              <code>{firmware.bootEntryHex}</code>
              <p>AA 握手逻辑包：</p>
              <code data-testid="firmware-handshake">
                {firmware.handshakeHex}
              </code>
              <p>第 0 块（补零至 64 字节）：</p>
              <code>{firmware.firstBlockHex}</code>
              <p>最后一块（补零至 64 字节）：</p>
              <code>{firmware.lastBlockHex}</code>
              <p>
                BW150 实测 USB：发送为 55 加逻辑包前 63 字节，接收为 AA 加应答前
                63 字节。满块校验全部数据回显与 CRC 低字节；末块 EE 后仍等待
                FF。
              </p>
            </details>
          </>
        )}
        {firmware && !hardware && (
          <MessageBar intent="warning">
            <MessageBarBody>{firmware.limitation}</MessageBarBody>
          </MessageBar>
        )}
        <Button
          appearance="primary"
          disabled={!firmware || busy}
          onClick={() => {
            setRehearsal(null);
            void onTask(async () => {
              const result = await api.rehearseFirmware(
                firmware!.name,
                data.current,
              );
              if (!result.offline || result.phase !== "complete")
                throw new Error("升级握手预演未完成");
              setRehearsal(result);
            });
          }}
        >
          离线预演升级握手
        </Button>
        {rehearsal && (
          <div className="firmware-rehearsal" data-testid="firmware-rehearsal">
            <Badge color="success" appearance="tint">
              协议预演完成
            </Badge>
            <p>
              已校验 {rehearsal.acknowledgedBlocks} / {rehearsal.blocks}{" "}
              个分块、{rehearsal.transferredBytes.toLocaleString()}{" "}
              字节。未向设备发送升级命令。
            </p>
            <ol>
              {rehearsal.events.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ol>
          </div>
        )}
      </Card>
      <Card className="firmware-status">
        <div className="section-head">
          <h2>USB 升级与恢复</h2>
        </div>
        <UsbPlug20Regular />
        <h2>
          {selectedDevice?.name ?? snapshot.device?.name ?? "尚未选择设备"}
        </h2>
        <p>序列号 {selectedDevice?.serial ?? snapshot.device?.serial ?? "—"}</p>
        <Badge
          appearance="tint"
          color={snapshot.connected ? "success" : "informative"}
        >
          {snapshot.connected ? "设备在线" : "等待连接"}
        </Badge>
        {hardware && (
          <>
            <Field label="升级 USB 设备">
              <Select
                aria-label="升级 USB 设备"
                value={selectedPath}
                disabled={busy || scanning}
                onChange={(_, d) => setSelectedPath(d.value)}
              >
                <option value="">请选择 USB 设备</option>
                {devices.map((device) => (
                  <option key={device.path} value={device.path}>
                    {device.name} · {device.serial}
                  </option>
                ))}
              </Select>
            </Field>
            <Button disabled={busy || scanning} onClick={() => void scan()}>
              {scanning ? "正在扫描…" : "刷新 USB 设备"}
            </Button>
            {scanError && (
              <MessageBar intent="error">
                <MessageBarBody>{scanError}</MessageBarBody>
              </MessageBar>
            )}
            {snapshot.recording && (
              <p>
                {snapshot.recordingPaused &&
                snapshot.telemetry?.running === false
                  ? "确认升级后将保存并关闭已暂停的记录。"
                  : "请先停止负载并暂停记录，再开始升级。"}
              </p>
            )}
            {otherConnection && <p>请先断开当前设备，再选择另一个升级目标。</p>}
            {selectedDevice && !eligible && (
              <p>此设备不属于已核准的 BW150 应用 / IAP 接口。</p>
            )}
            <p>
              {recovery
                ? "已发现 IAP 升级模式。可以从第 0 块重新传输同一份原厂固件。"
                : "升级前请退出官方程序，停止负载并移除测试输入。应用会检查新的待机遥测，随后独占 USB 传输。"}
            </p>
            <Button
              appearance="primary"
              disabled={!startable}
              onClick={() => setConfirm(true)}
            >
              {recovery ? "恢复 BW150 固件…" : "升级 BW150 固件…"}
            </Button>
          </>
        )}
        {job && (
          <div
            className="firmware-job"
            data-testid="firmware-job"
            aria-live="polite"
          >
            <Badge
              appearance="tint"
              color={
                job.phase === "complete"
                  ? "success"
                  : job.active
                    ? "informative"
                    : "warning"
              }
            >
              {phases[job.phase] ?? job.phase}
            </Badge>
            <ProgressBar
              aria-label="固件传输进度"
              value={job.blocks ? job.acknowledgedBlocks / job.blocks : 0}
            />
            <p>
              {job.acknowledgedBlocks.toLocaleString()} /{" "}
              {job.blocks.toLocaleString()} 块 ·{" "}
              {job.blocks
                ? ((job.acknowledgedBlocks / job.blocks) * 100).toFixed(1)
                : "0.0"}
              %
            </p>
            <p>{job.message}</p>
            {job.flashConfirmed && (
              <p>
                设备 FF 完成应答已确认。
                {job.phase === "complete"
                  ? "正常应用回读已通过。"
                  : "正常应用回读结果以最终状态为准。"}
              </p>
            )}
            <details>
              <summary>传输日志</summary>
              <p className="mono">{job.logPath}</p>
            </details>
            {job.active && (
              <Button
                disabled={!job.cancellable}
                onClick={() => void onTask(() => api.cancelFirmware())}
              >
                停止后续传输
              </Button>
            )}
            {job.active && !job.cancellable && (
              <p>当前阶段请保持设备供电，等待设备完成与重新连接。</p>
            )}
          </div>
        )}
      </Card>
      <Dialog
        open={confirm}
        onOpenChange={(_, d) => {
          if (!busy) setConfirm(d.open);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {recovery ? "确认恢复 BW150 固件" : "确认升级 BW150 固件"}
            </DialogTitle>
            <DialogContent>
              <p>
                目标：{selectedDevice?.name} · {selectedDevice?.serial}
              </p>
              <p>
                固件：{firmware?.name} · {firmware?.bytes.toLocaleString()} 字节
              </p>
              <p className="mono firmware-digest">SHA-256 {firmware?.sha256}</p>
              <p>
                确认后将停止当前监测并
                {recovery ? "从第 0 块重新传输" : "重启进入升级模式"}
                。请保持供电和 USB 连接，等待烧写及正常应用回读完成。
              </p>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setConfirm(false)}>
                返回
              </Button>
              <Button
                appearance="primary"
                disabled={!startable}
                onClick={() => {
                  if (!firmware || !selectedDevice || !startable) return;
                  setConfirm(false);
                  void onTask(() =>
                    api.startFirmware(
                      selectedDevice.path,
                      firmware.name,
                      data.current,
                    ),
                  );
                }}
              >
                确认并开始
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
