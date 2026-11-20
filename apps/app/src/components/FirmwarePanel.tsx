import { useEffect, useRef, useState } from "react";
import { MenuSelect } from "./MenuSelect";
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  ProgressBar,
} from "@fluentui/react-components";
import { ArrowUpload20Regular } from "@fluentui/react-icons";
import { api, native } from "../lib/api";
import { Notification, useNotify } from "./Notifications";
import type { DeviceInfo, FirmwareInfo, Snapshot } from "../lib/types";

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

/** Observe the job even while another application page is open. */
export function FirmwareNotification({ job }: { job: Snapshot["firmware"] }) {
  const notify = useNotify();
  const reported = useRef("");
  const active = job?.active ?? true;
  const phase = job?.phase ?? "";
  const startedAt = job?.startedAt ?? 0;
  const sha256 = job?.sha256 ?? "";
  const message = job?.message ?? "";
  const verified = !!job?.flashConfirmed && !!job?.restoredDevice;
  useEffect(() => {
    if (active || !["complete", "failed", "cancelled"].includes(phase)) return;
    const key = `${startedAt}:${sha256}:${phase}:${verified}`;
    if (reported.current === key) return;
    reported.current = key;
    const complete = phase === "complete" && verified;
    notify({
      text: complete ? "固件升级完成" : message || "固件升级未完成",
      error: phase === "failed" || (phase === "complete" && !complete),
      intent: phase === "cancelled" ? "info" : undefined,
    });
  }, [active, phase, startedAt, sha256, message, verified, notify]);
  return null;
}

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
  const notify = useNotify();
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const job = snapshot.firmware;
  const hardware = !!firmware?.hardwareWriteAvailable;
  const selectedDevice = devices.find((d) => d.path === selectedPath);
  const otherConnection =
    snapshot.connected && snapshot.device?.path !== selectedPath;
  const startable =
    hardware && !!selectedDevice && !busy && !scanning && !otherConnection;
  const showTarget = !!firmware || !!job;
  const percentage = job?.blocks
    ? Math.round((job.acknowledgedBlocks / job.blocks) * 100)
    : 0;
  const scan = async () => {
    setScanning(true);
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
      notify({ text: String(e), error: true });
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
  return (
    <div className={`firmware-layout${showTarget ? " has-target" : ""}`}>
      <Card>
        <div className="section-head">
          <h2>固件检查</h2>
          <ArrowUpload20Regular />
        </div>
        <div className="firmware-drop">
          <div className="firmware-file-icon">
            <ArrowUpload20Regular />
          </div>
          <h3>{firmware?.name ?? "选择 .bin 固件"}</h3>
          <p>
            {firmware
              ? `${firmware.bytes.toLocaleString()} 字节 · ${firmware.blocks.toLocaleString()} 块`
              : "读取原始文件，显示大小、摘要和升级分块。"}
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
              data.current = "";
              void onTask(async () => {
                if (file.size === 0 || file.size > 1_024_000)
                  throw new Error("固件大小必须在 1 至 1,024,000 字节之间");
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
              <dt>CRC16</dt>
              <dd className="mono">{firmware.crc16}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{firmware.sha256}</dd>
            </dl>
          </>
        )}
        {firmware && !hardware && (
          <Notification text={firmware.limitation} intent="warning" />
        )}
      </Card>
      {showTarget && (
        <Card className="firmware-status">
          <div className="section-head">
            <h2>选择 USB 设备</h2>
          </div>
          {(hardware || job) && (
            <>
              <div className="firmware-device-controls">
                <MenuSelect
                  aria-label="升级 USB 设备"
                  value={selectedPath}
                  disabled={busy || scanning || !hardware || !devices.length}
                  placeholder="请选择 USB 设备"
                  onChange={setSelectedPath}
                  options={devices.map((device) => ({
                    value: device.path,
                    label: device.serial
                      ? `${device.name} · ${device.serial}`
                      : device.name,
                  }))}
                />
                <Button
                  disabled={busy || scanning || !native}
                  onClick={() => void scan()}
                >
                  刷新
                </Button>
                <Button
                  appearance="primary"
                  disabled={job?.active ? !job.cancellable : !startable}
                  onClick={() => {
                    if (job?.active) void onTask(() => api.cancelFirmware());
                    else setConfirm(true);
                  }}
                >
                  {job?.active ? "停止" : "刷写"}
                </Button>
              </div>
            </>
          )}
          {job && (
            <div
              className="firmware-job"
              data-testid="firmware-job"
              aria-live="polite"
            >
              <p className="firmware-phase">{phases[job.phase] ?? job.phase}</p>
              <ProgressBar
                aria-label="固件传输进度"
                value={job.blocks ? job.acknowledgedBlocks / job.blocks : 0}
              />
              <p className="firmware-progress">
                <span>{percentage}%</span>{" "}
                <span>
                  {job.acknowledgedBlocks}/{job.blocks}
                </span>
              </p>
              <div>
                <Button
                  disabled={!native || !job.logPath}
                  onClick={() =>
                    void api
                      .openFirmwareLog()
                      .catch((error) =>
                        notify({ text: String(error), error: true }),
                      )
                  }
                >
                  传输日志
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
      <Dialog
        open={confirm}
        onOpenChange={(_, d) => {
          if (!busy) setConfirm(d.open);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>确认刷写固件</DialogTitle>
            <DialogContent>
              <p>
                目标：{selectedDevice?.name} · {selectedDevice?.serial}
              </p>
              <p>
                固件：{firmware?.name} · {firmware?.bytes.toLocaleString()} 字节
              </p>
              <p className="mono firmware-digest">SHA-256 {firmware?.sha256}</p>
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
