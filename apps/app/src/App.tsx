import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Select,
  Spinner,
  Switch,
  Tab,
  TabList,
  ToggleButton,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import {
  ArrowDownload20Regular,
  ArrowSync20Regular,
  Bluetooth20Regular,
  CheckmarkCircle20Regular,
  DataLine20Regular,
  Delete20Regular,
  DocumentTable20Regular,
  FolderOpen20Regular,
  Pause20Filled,
  Play20Filled,
  PlugConnected20Regular,
  PlugDisconnected20Regular,
  Settings20Regular,
  ShieldCheckmark20Regular,
  Temperature20Regular,
  UsbPlug20Regular,
  WindowSettings20Regular,
} from "@fluentui/react-icons";
import { api, native } from "./lib/api";
import { measurementColor } from "./lib/theme";
import { download, exportCsv } from "./lib/csv";
import { importCsv } from "./lib/csvImport";
import { Notifications } from "./components/Notifications";
import {
  measurementKeys,
  readChartSelection,
  readSharedChartBounds,
  type ChartBounds,
} from "./lib/analysis";
import { DataReview } from "./components/DataReview";
import { ChartTimeSelect } from "./components/ChartTimeSelect";
import { readChartTimeMode, sampleElapsedMs } from "./lib/chartTime";
import { completeRecordCounters } from "./lib/records";
import { useAutoConnect } from "./lib/useAutoConnect";
import { ChartScaleSettings } from "./components/ChartScaleSettings";
import { MeasurementSelector } from "./components/MeasurementSelector";
import { SpecialTests } from "./components/SpecialTests";
import { FirmwarePanel } from "./components/FirmwarePanel";
import { BleControls } from "./components/BleControls";
import { LoadParameter, LoadTimeLimit } from "./components/LoadParameter";
import { loadParameterRange, timeLimitWrites } from "./lib/loadControl";
import {
  emptySnapshot,
  modes,
  type DeviceInfo,
  type Snapshot,
  type Telemetry,
  type UsbDiagnostics,
  type BluetoothState,
  type RecordingInfo,
  type PromptContext,
} from "./lib/types";
import { TrendChart, type SeriesKey } from "./components/TrendChart";

type Page = "live" | "history" | "settings" | "firmware" | "application";
const nav = [
  ["live", "实时监控", DataLine20Regular],
  ["history", "数据记录", DocumentTable20Regular],
  ["settings", "设备设置", Settings20Regular],
  ["application", "应用设置", WindowSettings20Regular],
] as const;
const fmt = (v: number | null | undefined, n = 3) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: n,
        maximumFractionDigits: n,
        useGrouping: false,
      });
const time = (v: number) =>
  new Date(v).toLocaleTimeString("zh-CN", { hour12: false });
function Parameter({
  label,
  value,
  unit = "",
  disabled,
  onApply,
  min,
  max,
  step = 0.001,
  fractionDigits,
}: {
  label: string;
  value: number | undefined;
  unit?: string;
  disabled: boolean;
  onApply: (n: number) => Promise<void>;
  min?: number;
  max?: number;
  step?: number;
  fractionDigits?: number;
}) {
  const formatValue = (n: number | undefined) =>
    n === undefined
      ? ""
      : fractionDigits === undefined
        ? String(Number(n.toFixed(5)))
        : n.toFixed(fractionDigits);
  const [text, setText] = useState(formatValue(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setText(formatValue(value)), [value, fractionDigits]);
  return (
    <div className="parameter">
      <Field
        label={label}
        validationMessage={error || undefined}
        validationState={error ? "error" : "none"}
      >
        <div className="parameter-input">
          <Input
            aria-label={label}
            type="number"
            value={text}
            placeholder="—"
            min={min}
            max={max}
            step={step}
            disabled={disabled || busy}
            onChange={(_, d) => setText(d.value)}
            contentAfter={unit}
          />
          <Button
            disabled={disabled || busy || text.trim() === ""}
            onClick={async () => {
              const n = Number(text);
              if (
                !Number.isFinite(n) ||
                (min !== undefined && n < min) ||
                (max !== undefined && n > max)
              ) {
                setError("请输入范围内的有效数值");
                return;
              }
              setError("");
              setBusy(true);
              try {
                await onApply(n);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size="tiny" /> : "应用"}
          </Button>
        </div>
      </Field>
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("live");
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [modeError, setModeError] = useState("");
  const [applicationTab, setApplicationTab] = useState("appearance");
  const [dark, setDark] = useState(
    () => localStorage.getItem("atorch-theme") === "dark",
  );
  const theme = dark ? webDarkTheme : webLightTheme;
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [samples, setSamples] = useState<Telemetry[]>([]);
  const historyEpoch = useRef(0);
  const [chartRevision, setChartRevision] = useState(0);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceDialog, setDeviceDialog] = useState(false);
  const [connectionType, setConnectionType] = useState<"usb" | "bluetooth">(
    "usb",
  );
  const [bluetoothDevices, setBluetoothDevices] = useState<DeviceInfo[]>([]);
  const [bluetoothState, setBluetoothState] = useState<BluetoothState | null>(
    null,
  );
  const [scanning, setScanning] = useState(false);
  const scanGeneration = useRef(0);
  const [usbDiagnostics, setUsbDiagnostics] = useState<UsbDiagnostics | null>(
    null,
  );
  const [scanError, setScanError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [rootBusy, setRootBusy] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [taskBusy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
    intent?: "info";
  } | null>(null);
  const [selected, setSelected] = useState<SeriesKey[]>(readChartSelection);
  const [range, setRange] = useState("all");
  const [chartTimeMode, setChartTimeMode] = useState(readChartTimeMode);
  const [chartBounds, setChartBounds] = useState<ChartBounds>(
    readSharedChartBounds,
  );
  const [imported, setImported] = useState<Telemetry[]>([]);
  const [importName, setImportName] = useState("");
  const [importId, setImportId] = useState("");
  const [historyTab, setHistoryTab] = useState("current");
  const [historySource, setHistorySource] = useState<"import" | "recordings">(
    "recordings",
  );
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [archiveId, setArchiveId] = useState("");
  const [archiveRows, setArchiveRows] = useState<Telemetry[]>([]);
  const [archiveName, setArchiveName] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [importRevision, setImportRevision] = useState(0);
  const [confirm, setConfirm] = useState<{
    kind: string;
    value: number;
    title: string;
    text: string;
    expectedMode?: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { phase: autoPhase, suspend: suspendAutoConnection } = useAutoConnect(
    native &&
      snapshotReady &&
      !snapshot.connected &&
      !snapshot.firmware?.active &&
      !deviceDialog &&
      !taskBusy &&
      !rootBusy &&
      !scanning &&
      page !== "firmware",
    (next) => {
      ++historyEpoch.current;
      setSamples([]);
      setConnectionError(null);
      setConnectionType(
        next.device?.transport === "bluetooth" ? "bluetooth" : "usb",
      );
      setSnapshot(next);
    },
  );
  const busy =
    taskBusy || !!snapshot.firmware?.active || autoPhase === "connecting";
  const settings = snapshot.settings;
  const loadSettings = settings ?? {
    mode: 0,
    target: 0,
    cutoffVoltage: 0,
    overCurrent: 20,
    overPower: 400,
  };
  const rootUsb = usbDiagnostics?.rootUsb;
  const t = snapshot.telemetry;
  const bluetooth = snapshot.device?.transport === "bluetooth";
  const transportLabel = bluetooth ? "蓝牙 BLE" : "USB HID";
  const deviceError = connectionError || snapshot.error;
  const visibleDevices =
    connectionType === "bluetooth" ? bluetoothDevices : devices;
  const mode = modes[settings?.mode ?? 0] ?? [
    "UNKNOWN",
    "未知模式",
    "请读取设备模式",
    "",
  ];
  const basicMode = !!settings && settings.mode <= 3;
  const startableMode = !!settings && settings.mode <= 8;
  const stagePending =
    !!snapshot.specialTest?.reading.prompt &&
    snapshot.specialTest.reading.mode === settings?.mode;
  const targetMode = basicMode || settings?.mode === 7 || settings?.mode === 8;
  const canSwitchMode =
    snapshot.connected &&
    !bluetooth &&
    !!settings &&
    t?.running === false &&
    !busy;
  const run = useCallback(
    async (task: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        const result = await task();
        if (success && result !== null)
          setMessage({ text: success, error: false });
      } catch (e) {
        setMessage({ text: String(e), error: true });
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  const command = (
    kind: string,
    value: number,
    expectedMode?: number,
    expectedPrompt?: PromptContext,
  ) =>
    run(async () => {
      await api.command(kind, value, expectedMode, expectedPrompt);
      setSnapshot(await api.snapshot());
    }, "设备已确认设置");
  const applyLoadParameter = async (kind: string, value: number) => {
    setBusy(true);
    try {
      await api.command(kind, value, settings?.mode);
      setSnapshot(await api.snapshot());
    } finally {
      setBusy(false);
    }
  };
  const applyTimeLimit = async (hours: number, minutes: number) => {
    if (!settings) throw new Error("请先读取设备参数");
    setBusy(true);
    try {
      for (const write of timeLimitWrites(settings, hours, minutes))
        await api.command(write.kind, write.value, settings.mode);
      const next = await api.snapshot();
      setSnapshot(next);
      if (
        next.settings?.limitHours !== hours ||
        next.settings?.limitMinutes !== minutes
      )
        throw new Error("运行时限回读不一致，请核对设备参数后重试");
    } catch (error) {
      setSnapshot(await api.snapshot());
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const connectionTask = async (task: () => Promise<void>) => {
    setBusy(true);
    setConnectionError(null);
    try {
      await suspendAutoConnection();
      await task();
      setSnapshot(await api.snapshot());
    } catch (e) {
      setConnectionError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const switchMode = (index: number) =>
    run(async () => {
      setModeError("");
      try {
        await api.command("mode", index, settings?.mode);
        const next = await api.snapshot();
        setSnapshot(next);
        if (next.settings?.mode !== index)
          throw new Error("模式回读尚未同步，请查看设备当前模式");
        setModeDialogOpen(false);
      } catch (error) {
        setModeError(String(error));
        throw error;
      }
    }, `已切换到 ${modes[index][0]} · ${modes[index][1]}`);
  const refresh = useCallback(async () => {
    const generation = ++scanGeneration.current;
    setScanning(true);
    setScanError(null);
    try {
      await suspendAutoConnection();
      const [found, diagnostics] = await Promise.all([
        api.discover(),
        api.usbDiagnostics(),
      ]);
      if (generation !== scanGeneration.current) return;
      setDevices(found);
      setUsbDiagnostics(diagnostics);
    } catch (e) {
      if (generation !== scanGeneration.current) return;
      setDevices([]);
      setUsbDiagnostics(null);
      setScanError(String(e));
    } finally {
      if (generation === scanGeneration.current) setScanning(false);
    }
  }, [suspendAutoConnection]);
  const setRootHost = async (enabled: boolean) => {
    setRootBusy(true);
    setRootError(null);
    try {
      const state = await api.rootUsbHost(enabled);
      setUsbDiagnostics((current) => current && { ...current, rootUsb: state });
      setDevices([]);
      if (enabled) await new Promise((resolve) => setTimeout(resolve, 700));
      await refresh();
      setSnapshot(await api.snapshot());
      return true;
    } catch (e) {
      setRootError(String(e));
      await refresh();
      return false;
    } finally {
      setRootBusy(false);
    }
  };
  const refreshBluetooth = async () => {
    const generation = ++scanGeneration.current;
    setScanning(true);
    setScanError(null);
    try {
      await suspendAutoConnection();
      const status = await api.bluetoothStatus();
      if (generation !== scanGeneration.current) return;
      setBluetoothState(status);
      if (!status?.supported) throw new Error("此设备不支持 BLE 蓝牙");
      const found = await api.discoverBluetooth();
      if (generation === scanGeneration.current) setBluetoothDevices(found);
    } catch (e) {
      if (generation !== scanGeneration.current) return;
      setBluetoothDevices([]);
      setScanError(String(e));
    } finally {
      if (generation === scanGeneration.current) {
        const status = await api.bluetoothStatus().catch(() => null);
        if (generation === scanGeneration.current) {
          setBluetoothState(status);
          setScanning(false);
        }
      }
    }
  };
  const closeDeviceDialog = async () => {
    if (rootBusy || busy) return;
    ++scanGeneration.current;
    setScanning(false);
    if (connectionType === "bluetooth")
      await api.stopBluetoothScan().catch(() => {});
    if (!snapshot.connected && (rootUsb?.enabled || rootUsb?.restorePending)) {
      if (!(await setRootHost(false))) return;
    }
    setDeviceDialog(false);
  };
  useEffect(() => {
    // A transport failure/detach can also restore the native USB role. Refresh
    // the switch from native state when the connection dialog is visible.
    if (deviceDialog && connectionType === "usb") void refresh();
  }, [deviceDialog, connectionType, snapshot.connected, refresh]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let intervalMs = 1000;
    let nextPollAt = performance.now();
    const poll = async () => {
      const started = performance.now();
      const epoch = historyEpoch.current;
      try {
        const next = await api.snapshot();
        const nextInterval =
          next.device?.transport === "bluetooth"
            ? 1000
            : 1000 / (next.usbSampleRateHz ?? 1);
        if (nextInterval !== intervalMs) {
          intervalMs = nextInterval;
          nextPollAt = started;
        }
        if (alive && epoch === historyEpoch.current) {
          setSnapshot(next);
          setSnapshotReady(true);
          if (next.connected) {
            const history = await api.history();
            if (alive && epoch === historyEpoch.current) setSamples(history);
          }
        }
      } catch (e) {
        if (alive)
          setSnapshot((current) => ({
            ...current,
            error: `连接服务异常：${String(e)}`,
          }));
      } finally {
        if (alive) {
          nextPollAt += intervalMs;
          const now = performance.now();
          while (nextPollAt <= now) nextPollAt += intervalMs;
          timer = setTimeout(poll, Math.max(1, nextPollAt - now));
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("atorch-theme", dark ? "dark" : "light");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.style.backgroundColor =
      theme.colorNeutralBackground2;
  }, [dark, theme]);
  useEffect(() => {
    localStorage.setItem("atorch-chart-bounds", JSON.stringify(chartBounds));
  }, [chartBounds]);
  useEffect(() => {
    localStorage.setItem("atorch-chart-time-mode", chartTimeMode);
  }, [chartTimeMode]);
  useEffect(() => {
    localStorage.setItem("atorch-chart-selection", JSON.stringify(selected));
  }, [selected]);
  useEffect(() => {
    if (page !== "history" || historyTab !== "history") return;
    let alive = true;
    setArchiveLoading(true);
    setArchiveError("");
    api
      .recordings()
      .then((files) => {
        if (alive) {
          setRecordings(files);
          setSelectedRecords((ids) =>
            ids.filter((id) => files.some((file) => file.id === id)),
          );
        }
      })
      .catch((e) => {
        if (alive) setArchiveError(String(e));
      })
      .finally(() => {
        if (alive) setArchiveLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [page, historyTab, archiveRevision]);
  const recordSamples = useMemo(
    () => completeRecordCounters(samples),
    [samples],
  );
  const sampleElapsed = (row: Telemetry) =>
    sampleElapsedMs(row, samples[0]?.timestamp ?? row.timestamp);
  const latestElapsed = samples.length ? sampleElapsed(samples.at(-1)!) : 0;
  const rangeTime = (row: Telemetry) =>
    chartTimeMode === "elapsed" ? sampleElapsed(row) : row.timestamp;
  const chartSamples =
    range === "all"
      ? recordSamples
      : recordSamples.filter(
          (s) =>
            rangeTime(s) >=
            (samples.length ? rangeTime(samples.at(-1)!) : 0) -
              Number(range) * 1000,
        );
  const clearSamples = () =>
    run(async () => {
      ++historyEpoch.current;
      await api.clearSamples();
      ++historyEpoch.current;
      setSamples([]);
      setChartRevision((revision) => revision + 1);
      setClearDialogOpen(false);
      setSnapshot(await api.snapshot());
    });
  const activeRows =
    historyTab === "current"
      ? recordSamples
      : historySource === "import"
        ? imported
        : archiveRows;
  const saveImage = (url: string) => {
    const name = `Atorch_chart_${Date.now()}.png`;
    if (native) {
      void run(async () => {
        const path = await api.savePng(name, url);
        if (path) setMessage({ text: `曲线图片已保存：${path}`, error: false });
      });
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  };
  const saveRows = (rows: Telemetry[]) => {
    const name = `Atorch_${Date.now()}.csv`;
    const content = exportCsv(rows);
    if (native)
      void run(async () => {
        const path = await api.saveCsv(name, content);
        if (path) {
          setMessage({ text: `已导出：${path}`, error: false });
          setArchiveRevision((n) => n + 1);
        }
      });
    else download(name, content);
  };

  return (
    <FluentProvider theme={theme} className="theme-root">
      <Notifications message={message} />
      <div className="app">
        <aside className="sidebar">
          <nav>
            {nav.map(([id, label, Icon]) => (
              <ToggleButton
                key={id}
                size="medium"
                appearance="subtle"
                checked={
                  page === id || (id === "settings" && page === "firmware")
                }
                aria-label={label}
                aria-current={
                  page === id || (id === "settings" && page === "firmware")
                    ? "page"
                    : undefined
                }
                className="nav-item"
                icon={{ children: <Icon />, className: "nav-item-icon" }}
                onClick={() => setPage(id)}
              >
                <span className="nav-item-label">{label}</span>
              </ToggleButton>
            ))}
          </nav>
          <section className="sidebar-device" aria-label="设备连接">
            <div className="device-info">
              <div className="small-label">当前设备</div>
              <div className="sidebar-device-name">
                <strong>
                  {snapshot.device?.name.replace("ATORCH ", "") ?? "尚未连接"}
                </strong>
              </div>
            </div>
            <span
              className={`device-connection-status ${snapshot.connected && !deviceError ? "connected" : "disconnected"}`}
              id="device-connection-status"
            >
              {deviceError
                ? "连接异常"
                : snapshot.connected
                  ? `${transportLabel} 已连接`
                  : autoPhase === "connecting"
                    ? "正在自动连接…"
                    : autoPhase === "usb"
                      ? "正在扫描 USB…"
                      : autoPhase === "bluetooth"
                        ? "正在扫描 BLE…"
                        : "未连接"}
            </span>
            <Button
              appearance="subtle"
              className="nav-item device-manager-button"
              disabled={busy}
              aria-label={snapshot.connected ? "管理设备" : "连接设备"}
              aria-describedby="device-connection-status"
              icon={{
                className: "nav-item-icon",
                children: snapshot.connected ? (
                  <PlugConnected20Regular />
                ) : (
                  <PlugDisconnected20Regular />
                ),
              }}
              onClick={() => {
                setDeviceDialog(true);
              }}
            >
              <span className="device-manager-label nav-item-label">
                {snapshot.connected ? "管理设备" : "连接设备"}
              </span>
            </Button>
            {deviceError && <span className="device-error">{deviceError}</span>}
          </section>
        </aside>
        <div className="main-shell">
          <main>
            <div className="page-heading">
              <div>
                <h1>
                  {
                    {
                      live: "实时监控",
                      history: "数据记录",
                      settings: "设备设置",
                      firmware: "设备设置",
                      application: "应用设置",
                    }[page]
                  }
                </h1>
              </div>
            </div>
            {!native && (
              <MessageBar intent="info">
                <MessageBarBody>
                  界面预览模式。USB 设备连接与控制请使用 Windows 或 Android
                  应用；这里可以导入历史 CSV 数据。
                </MessageBarBody>
              </MessageBar>
            )}
            {snapshot.recordingError && (
              <MessageBar intent="error">
                <MessageBarBody>{snapshot.recordingError}</MessageBarBody>
              </MessageBar>
            )}
            {snapshot.firmware?.active && (
              <MessageBar intent="info">
                <MessageBarBody>
                  固件升级正在进行：{snapshot.firmware.message}
                  。请保持设备供电，完成前应用会保持打开。
                </MessageBarBody>
                {page !== "firmware" && (
                  <MessageBarActions>
                    <Button size="small" onClick={() => setPage("firmware")}>
                      查看升级进度
                    </Button>
                  </MessageBarActions>
                )}
              </MessageBar>
            )}

            {page === "live" && (
              <>
                <div className="metrics">
                  {(
                    [
                      ["voltage", "电压", t?.voltage, "V", 3],
                      ["current", "电流", t?.current, "A", 3],
                      ["power", "功率", t?.power, "W", 3],
                      ["resistance", "电阻", t?.resistance, "Ω", 3],
                      ["energy", "累计电量", t?.energy, "Wh", 3],
                      [
                        "capacity",
                        "累计容量",
                        t?.capacity,
                        "mAh",
                        bluetooth ? 0 : 3,
                      ],
                    ] as const
                  ).map(([key, title, value, unit, digits]) => (
                    <Card
                      key={key}
                      className="metric"
                      aria-label={title}
                      data-measurement={key}
                    >
                      <div className="metric-title">
                        <h2>{title}</h2>
                        <span
                          className="metric-symbol"
                          style={{
                            color:
                              chartBounds[key]?.color ??
                              measurementColor(theme, key),
                          }}
                        >
                          {unit}
                        </span>
                      </div>
                      <div
                        className="metric-value mono"
                        style={{
                          color:
                            chartBounds[key]?.color ??
                            measurementColor(theme, key),
                        }}
                      >
                        <span className="metric-number">
                          {fmt(value, digits)}
                        </span>
                        <span className="metric-unit">{unit}</span>
                      </div>
                    </Card>
                  ))}
                </div>
                <Card className="chart-card">
                  <div className="section-head">
                    <div>
                      <h2>实时曲线</h2>
                    </div>
                    <div className="chart-toolbar">
                      {!bluetooth && (
                        <Select
                          aria-label="USB 采样率"
                          value={snapshot.usbSampleRateHz ?? 1}
                          disabled={!native || busy}
                          onChange={(event) => {
                            const hz = Number(event.target.value);
                            void run(async () => {
                              await api.usbSampleRate(hz);
                              setSnapshot(await api.snapshot());
                            });
                          }}
                        >
                          {[1, 2, 5, 10].map((hz) => (
                            <option key={hz} value={hz}>
                              {hz} Hz 采样
                            </option>
                          ))}
                        </Select>
                      )}
                      <ChartTimeSelect
                        value={chartTimeMode}
                        onChange={setChartTimeMode}
                      />
                      <Select
                        aria-label="曲线时间范围"
                        value={range}
                        onChange={(e) => setRange(e.target.value)}
                      >
                        <option value="60">最近 1 分钟</option>
                        <option value="300">最近 5 分钟</option>
                        <option value="1800">最近 30 分钟</option>
                        <option value="all">全部数据</option>
                      </Select>
                    </div>
                  </div>
                  <MeasurementSelector
                    selected={selected}
                    onChange={setSelected}
                    bounds={chartBounds}
                    theme={theme}
                  />
                  <TrendChart
                    key={`${chartRevision}|${chartTimeMode}`}
                    samples={chartSamples}
                    elapsed={
                      chartTimeMode === "elapsed"
                        ? {
                            origin: samples[0]?.timestamp ?? 0,
                            current: Math.max(
                              snapshot.samplingElapsedMs ?? 0,
                              latestElapsed,
                            ),
                            fromZero: range === "all",
                          }
                        : undefined
                    }
                    selected={selected}
                    theme={theme}
                    bounds={chartBounds}
                    onImage={saveImage}
                    imageBusy={busy}
                    footerActions={
                      <div className="record-actions">
                        <Button
                          icon={
                            snapshot.samplingPaused ? (
                              <Play20Filled />
                            ) : (
                              <Pause20Filled />
                            )
                          }
                          disabled={!snapshot.connected || busy}
                          onClick={() =>
                            void run(async () => {
                              ++historyEpoch.current;
                              await api.sampling(!!snapshot.samplingPaused);
                              ++historyEpoch.current;
                              setSnapshot(await api.snapshot());
                            })
                          }
                        >
                          {snapshot.samplingPaused ? "继续" : "暂停"}
                        </Button>
                        <Button
                          icon={<Delete20Regular />}
                          disabled={busy}
                          onClick={() => {
                            if (samples.length || snapshot.sampleCount)
                              setClearDialogOpen(true);
                            else void clearSamples();
                          }}
                        >
                          清空
                        </Button>
                      </div>
                    }
                    exportAction={(rows) => (
                      <Button
                        icon={<ArrowDownload20Regular />}
                        disabled={!rows.length || busy}
                        onClick={() => saveRows(rows)}
                      >
                        导出
                      </Button>
                    )}
                  />
                </Card>
                <div className="monitor-grid">
                  <Card className="control-card">
                    {bluetooth ? (
                      <BleControls
                        key={snapshot.connectedAt}
                        connected={snapshot.connected}
                        busy={busy}
                        onTask={run}
                        onNotice={(text) =>
                          setMessage({ text, error: false, intent: "info" })
                        }
                      />
                    ) : (
                      <>
                        <div className="section-head">
                          <h2>负载控制</h2>
                          <Badge
                            appearance="tint"
                            color={t?.running ? "success" : "subtle"}
                          >
                            {t?.running == null
                              ? "状态未知"
                              : t.running
                                ? "运行中"
                                : "待机"}
                          </Badge>
                        </div>
                        <div className="mode-display">
                          <span className="mode-code">
                            {bluetooth ? "BLE" : mode[0]}
                          </span>
                          <div>
                            <strong>{bluetooth ? "蓝牙监测" : mode[1]}</strong>
                            <span>
                              {bluetooth
                                ? "模式与参数请通过 USB 读取"
                                : "由设备同步当前模式"}
                            </span>
                          </div>
                          <Button
                            size="small"
                            appearance="subtle"
                            className="mode-switch-button"
                            aria-label="切换测试模式"
                            disabled={busy}
                            onClick={() => {
                              setModeError("");
                              setModeDialogOpen(true);
                            }}
                          >
                            切换
                          </Button>
                        </div>
                        {basicMode || !settings ? (
                          <div
                            className="load-parameters"
                            key={`${snapshot.connectedAt}-${settings?.mode}`}
                          >
                            {(
                              [
                                "target",
                                "cutoffVoltage",
                                "overCurrent",
                                "overPower",
                              ] as const
                            ).map((kind) => (
                              <LoadParameter
                                key={kind}
                                range={loadParameterRange(kind, loadSettings)}
                                value={settings?.[kind] ?? undefined}
                                disabled={
                                  !snapshot.connected || busy || !settings
                                }
                                onApply={(value) =>
                                  applyLoadParameter(kind, value)
                                }
                              />
                            ))}
                            <LoadTimeLimit
                              hours={settings?.limitHours}
                              minutes={settings?.limitMinutes}
                              disabled={
                                !snapshot.connected || busy || !settings
                              }
                              onApply={applyTimeLimit}
                            />
                          </div>
                        ) : (
                          <>
                            {targetMode && (
                              <Parameter
                                key={`target-${settings?.mode}`}
                                label={`目标${mode[0] === "CV" ? "电压" : mode[0] === "CR" ? "电阻" : mode[0] === "CP" ? "功率" : "电流"}`}
                                value={settings?.target ?? undefined}
                                unit={mode[3]}
                                disabled={
                                  !snapshot.connected ||
                                  busy ||
                                  !settings ||
                                  !targetMode
                                }
                                min={0}
                                onApply={(n) =>
                                  api.command("target", n, settings?.mode)
                                }
                              />
                            )}
                            {settings && !targetMode && (
                              <p className="muted">
                                此模式使用专用测试参数，请在设备面板设置；普通电流目标值不适用。
                              </p>
                            )}
                            <Parameter
                              label="截止电压"
                              value={settings?.cutoffVoltage}
                              unit="V"
                              fractionDigits={2}
                              disabled={
                                !snapshot.connected || busy || !settings
                              }
                              min={0}
                              onApply={(n) => api.command("cutoffVoltage", n)}
                            />
                            <div className="control-divider" />
                            <div className="control-detail">
                              <span>过流保护</span>
                              <strong>{fmt(settings?.overCurrent, 2)} A</strong>
                            </div>
                            <div className="control-detail">
                              <span>过功率保护</span>
                              <strong>{fmt(settings?.overPower, 1)} W</strong>
                            </div>
                            <div className="control-detail">
                              <span>运行时限</span>
                              <strong>
                                {settings
                                  ? `${settings.limitHours} 小时 ${settings.limitMinutes} 分钟`
                                  : "—"}
                              </strong>
                            </div>
                          </>
                        )}
                        <Button
                          size="large"
                          appearance="primary"
                          className={t?.running ? "stop-button" : "run-button"}
                          icon={
                            t?.running ? <Pause20Filled /> : <Play20Filled />
                          }
                          disabled={
                            !snapshot.connected ||
                            busy ||
                            !t ||
                            !settings ||
                            (!t.running && (!startableMode || stagePending))
                          }
                          onClick={() => {
                            if (t?.running) void command("running", 0);
                            else
                              setConfirm({
                                kind: "running",
                                value: 1,
                                title: "启动电子负载",
                                expectedMode: settings?.mode,
                                text: basicMode
                                  ? `设备将按当前 ${mode[1]}、目标值 ${fmt(settings?.target)} ${mode[3]} 启动。请确认负载输入与设备设置。`
                                  : `设备将启动 ${mode[0]} · ${mode[1]}，按专用流程控制负载。请确认接线及充满电压 ${fmt(settings?.fullVoltage)} V、截止电压 ${fmt(settings?.cutoffVoltage)} V。`,
                              });
                          }}
                        >
                          {bluetooth
                            ? "蓝牙暂不支持启停"
                            : t?.running
                              ? "停止负载"
                              : stagePending
                                ? "请先处理阶段选择"
                                : basicMode || !settings
                                  ? "启动负载"
                                  : startableMode
                                    ? "启动专用测试"
                                    : "请在设备面板启动测试"}
                        </Button>
                        {settings && !basicMode && (
                          <span className="control-note">
                            <ShieldCheckmark20Regular />
                            阶段控制与停止记录见下方专用测试区域
                          </span>
                        )}
                      </>
                    )}
                  </Card>
                  <Card>
                    <div className="section-head">
                      <h2>温度与散热</h2>
                      <Temperature20Regular />
                    </div>
                    <div className="thermal-grid">
                      {[
                        ["CPU", t?.cpuTemperature, "°C"],
                        ["探头", t?.ntcTemperature, "°C"],
                        ["MOS", t?.mosTemperature, "°C"],
                        ["风扇", t?.fanSpeed, "RPM"],
                      ].map(([label, v, unit]) => (
                        <div key={String(label)}>
                          <span>{label}</span>
                          <strong className="mono">
                            {fmt(
                              v as number | undefined,
                              unit === "RPM" ? 0 : 1,
                            )}
                            <small> {unit}</small>
                          </strong>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
                <SpecialTests
                  snapshot={snapshot}
                  busy={busy}
                  onCommand={command}
                  onTask={run}
                />
              </>
            )}

            {page === "history" && (
              <>
                <div className="page-toolbar">
                  <TabList
                    aria-label="数据记录分类"
                    selectedValue={historyTab}
                    onTabSelect={(_, d) => setHistoryTab(String(d.value))}
                  >
                    <Tab value="current">当前记录</Tab>
                    <Tab value="history">历史记录</Tab>
                  </TabList>
                  <div className="toolbar-buttons">
                    <Button
                      icon={<FolderOpen20Regular />}
                      disabled={busy}
                      onClick={() => {
                        if (!native) {
                          fileRef.current?.click();
                          return;
                        }
                        void run(async () => {
                          const document = await api.openCsv();
                          if (!document) return;
                          const rows = await importCsv({
                            base64: document.dataBase64,
                          });
                          const entry = await api.registerRecording(
                            document.path,
                          );
                          setImported(rows);
                          setImportName(document.name);
                          setImportId(entry?.id ?? document.path);
                          setImportRevision((n) => n + 1);
                          setArchiveRevision((n) => n + 1);
                          setHistorySource("import");
                          setHistoryTab("history");
                          setMessage({
                            text: `已导入：${document.name}`,
                            error: false,
                          });
                        });
                      }}
                    >
                      导入 CSV
                    </Button>
                  </div>
                </div>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  accept=".csv,text/csv"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    await run(async () => {
                      const rows = await importCsv({ file });
                      setImported(rows);
                      setImportName(file.name);
                      setImportId("");
                      setImportRevision((n) => n + 1);
                      setHistorySource("import");
                      setHistoryTab("history");
                    });
                    e.target.value = "";
                  }}
                />
                {historyTab === "history" && (
                  <Card>
                    <div className="section-head">
                      <div>
                        <h2>本机记录库</h2>
                      </div>
                      <div className="toolbar-buttons">
                        <Button
                          icon={<Delete20Regular />}
                          disabled={
                            archiveLoading || busy || !selectedRecords.length
                          }
                          onClick={() =>
                            void run(async () => {
                              const ids = [...selectedRecords];
                              await api.deleteRecordings(ids);
                              const clearImport = ids.includes(importId);
                              const clearArchive = ids.includes(archiveId);
                              if (clearImport) {
                                setImported([]);
                                setImportName("");
                                setImportId("");
                              }
                              if (clearArchive) {
                                setArchiveRows([]);
                                setArchiveName("");
                                setArchiveId("");
                              }
                              if (
                                historySource === "import"
                                  ? clearImport
                                  : clearArchive
                              )
                                setImportRevision((n) => n + 1);
                              setSelectedRecords([]);
                              setRecordings((files) =>
                                files.filter((file) => !ids.includes(file.id)),
                              );
                              setArchiveRevision((n) => n + 1);
                              setMessage({
                                text: `已删除 ${ids.length} 条记录`,
                                error: false,
                              });
                            })
                          }
                        >
                          删除记录
                        </Button>
                        <Button
                          icon={<ArrowSync20Regular />}
                          disabled={archiveLoading || busy}
                          onClick={() => setArchiveRevision((n) => n + 1)}
                        >
                          刷新记录
                        </Button>
                      </div>
                    </div>
                    {archiveError && (
                      <MessageBar intent="error">
                        <MessageBarBody>{archiveError}</MessageBarBody>
                      </MessageBar>
                    )}
                    {archiveLoading ? (
                      <Spinner label="读取本机记录" size="small" />
                    ) : (
                      <div className="recording-list">
                        {recordings.map((file) => (
                          <div className="recording-entry" key={file.id}>
                            <Checkbox
                              aria-label={`选择记录 ${file.name}`}
                              checked={selectedRecords.includes(file.id)}
                              disabled={busy}
                              onChange={(_, data) =>
                                setSelectedRecords((ids) =>
                                  data.checked
                                    ? [...new Set([...ids, file.id])]
                                    : ids.filter((id) => id !== file.id),
                                )
                              }
                            />
                            <DocumentTable20Regular />
                            <div className="recording-info">
                              <strong>{file.name}</strong>
                              <span className="recording-path">
                                {file.path}
                              </span>
                              <span>
                                {(file.bytes / 1024).toFixed(1)} KB ·{" "}
                                {file.modifiedAt
                                  ? new Date(file.modifiedAt).toLocaleString()
                                  : ""}
                              </span>
                            </div>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const document = await api.readRecording(
                                    file.id,
                                  );
                                  const rows = await importCsv({
                                    base64: document.dataBase64,
                                  });
                                  setArchiveRows(rows);
                                  setArchiveName(file.name);
                                  setArchiveId(file.id);
                                  setHistorySource("recordings");
                                  setImportRevision((n) => n + 1);
                                })
                              }
                            >
                              {archiveId === file.id ? "重新载入" : "打开记录"}
                            </Button>
                          </div>
                        ))}
                        {!recordings.length && (
                          <div className="table-empty">
                            {native
                              ? "暂无本机 CSV 记录，可导入已保存的 CSV 查看。"
                              : "请在桌面或 Android 应用中查看本机记录。"}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                )}
                <DataReview
                  selected={selected}
                  onSelectionChange={setSelected}
                  timeMode={chartTimeMode}
                  onTimeModeChange={setChartTimeMode}
                  key={`${historyTab}:${historySource}:${importRevision}`}
                  rows={activeRows}
                  title={
                    historyTab === "current"
                      ? "当前记录"
                      : `历史记录${(historySource === "import" ? importName : archiveName) ? ` · ${historySource === "import" ? importName : archiveName}` : ""}`
                  }
                  theme={theme}
                  bounds={chartBounds}
                  busy={busy}
                  onImage={saveImage}
                  onExport={saveRows}
                />
                {snapshot.recording && (
                  <div className="path-note">
                    <CheckmarkCircle20Regular />
                    {snapshot.recordingPaused ? "记录已暂停" : "正在记录"}：
                    {snapshot.recording}
                  </div>
                )}
              </>
            )}

            {(page === "settings" || page === "firmware") && (
              <TabList
                aria-label="设备设置分类"
                selectedValue={page}
                onTabSelect={(_, data) =>
                  setPage(data.value as "settings" | "firmware")
                }
              >
                <Tab
                  value="settings"
                  id="device-settings-tab-parameters"
                  aria-controls="device-settings-parameters"
                >
                  参数与维护
                </Tab>
                <Tab
                  value="firmware"
                  id="device-settings-tab-firmware"
                  aria-controls="device-settings-firmware"
                >
                  固件更新
                </Tab>
              </TabList>
            )}

            {page === "settings" && (
              <section
                className="settings-content"
                role="tabpanel"
                id="device-settings-parameters"
                aria-labelledby="device-settings-tab-parameters"
              >
                <div className="settings-grid">
                  <Card>
                    <div className="section-head">
                      <h2>负载与保护</h2>
                      <ShieldCheckmark20Regular />
                    </div>
                    {(
                      [
                        "cutoffVoltage",
                        "fullVoltage",
                        "cutoffCurrent",
                        "overCurrent",
                        "overPower",
                        "ntcLimit",
                        "mosLimit",
                      ] as const
                    ).map((key) => (
                      <LoadParameter
                        key={key}
                        range={loadParameterRange(key, loadSettings)}
                        value={settings?.[key]}
                        disabled={!snapshot.connected || busy || !settings}
                        onApply={(value) => applyLoadParameter(key, value)}
                      />
                    ))}
                  </Card>
                  <Card>
                    <div className="section-head">
                      <h2>设备显示与时限</h2>
                      <Settings20Regular />
                    </div>
                    {(
                      [
                        "brightness",
                        "standbyBrightness",
                        "standbySeconds",
                      ] as const
                    ).map((key) => (
                      <LoadParameter
                        key={key}
                        range={loadParameterRange(key, loadSettings)}
                        value={settings?.[key]}
                        disabled={!snapshot.connected || busy || !settings}
                        onApply={(value) => applyLoadParameter(key, value)}
                      />
                    ))}
                    <LoadTimeLimit
                      hours={settings?.limitHours}
                      minutes={settings?.limitMinutes}
                      disabled={!snapshot.connected || busy || !settings}
                      onApply={applyTimeLimit}
                    />
                  </Card>
                </div>
                <Card>
                  <div className="section-head">
                    <h2>校准与维护</h2>
                  </div>
                  <div className="calibration-grid">
                    {(
                      [
                        ["voltageCalibration", "电压校准系数"],
                        ["currentCalibration", "电流校准系数"],
                        ["temperatureCalibration", "温度校准系数"],
                      ] as const
                    ).map(([key, label]) => (
                      <Parameter
                        key={key}
                        label={label}
                        value={settings?.[key]}
                        fractionDigits={
                          key === "temperatureCalibration" ? 4 : undefined
                        }
                        min={key === "temperatureCalibration" ? 0.5 : undefined}
                        max={key === "temperatureCalibration" ? 2 : undefined}
                        disabled={!snapshot.connected || busy || !settings}
                        onApply={async (n) => {
                          setConfirm({
                            kind: key,
                            value: n,
                            title: "写入设备校准",
                            text: `将${label}调整为 ${n}。请确认已使用参考仪表核对。`,
                          });
                        }}
                      />
                    ))}
                  </div>
                  <div className="maintenance-actions">
                    {[
                      [
                        "clearCurrent",
                        "电流零点校准",
                        "将以当前输入条件执行电流零点校准。",
                      ],
                      [
                        "clearCounters",
                        "清空设备累计数据",
                        "将清空设备上的电量与容量累计数据。",
                      ],
                      [
                        "factoryReset",
                        "恢复出厂设置",
                        "将恢复设备出厂参数，现有校准与设置可能被重置。",
                      ],
                    ].map(([kind, title, text]) => (
                      <Button
                        key={kind}
                        disabled={!snapshot.connected || busy || bluetooth}
                        onClick={() =>
                          setConfirm({ kind, value: 0, title, text })
                        }
                      >
                        {title}
                      </Button>
                    ))}
                  </div>
                </Card>
                <Card>
                  <div className="section-head">
                    <h2>设备事件</h2>
                    <span>最近 {snapshot.logs.length} 条</span>
                  </div>
                  <div className="event-list">
                    {snapshot.logs.length ? (
                      snapshot.logs
                        .slice()
                        .reverse()
                        .map((l, i) => (
                          <div key={i}>
                            <span className="mono">{time(l.timestamp)}</span>
                            <Badge
                              size="small"
                              color={
                                l.level === "error" ? "danger" : "informative"
                              }
                              appearance="tint"
                            >
                              {l.level === "error" ? "异常" : "信息"}
                            </Badge>
                            <span>{l.message}</span>
                          </div>
                        ))
                    ) : (
                      <p className="muted">连接设备后，事件将显示在这里。</p>
                    )}
                  </div>
                </Card>
              </section>
            )}

            {page === "firmware" && (
              <section
                className="settings-content"
                role="tabpanel"
                id="device-settings-firmware"
                aria-labelledby="device-settings-tab-firmware"
              >
                <FirmwarePanel snapshot={snapshot} busy={busy} onTask={run} />
              </section>
            )}

            {page === "application" && (
              <div className="settings-content">
                <TabList
                  aria-label="应用设置分类"
                  selectedValue={applicationTab}
                  onTabSelect={(_, data) =>
                    setApplicationTab(String(data.value))
                  }
                >
                  <Tab
                    id="application-tab-appearance"
                    value="appearance"
                    aria-controls="application-panel-appearance"
                  >
                    外观
                  </Tab>
                  <Tab
                    id="application-tab-curves"
                    value="curves"
                    aria-controls="application-panel-curves"
                  >
                    曲线
                  </Tab>
                </TabList>
                {applicationTab === "appearance" ? (
                  <section
                    id="application-panel-appearance"
                    role="tabpanel"
                    aria-labelledby="application-tab-appearance"
                  >
                    <Card>
                      <h2>主题</h2>
                      <Switch
                        label="深色主题"
                        checked={dark}
                        onChange={(_, data) => setDark(data.checked)}
                      />
                    </Card>
                  </section>
                ) : (
                  <section
                    id="application-panel-curves"
                    role="tabpanel"
                    aria-labelledby="application-tab-curves"
                  >
                    <ChartScaleSettings
                      selected={measurementKeys}
                      bounds={chartBounds}
                      theme={theme}
                      onChange={(next) => {
                        setChartBounds(next);
                        setMessage({ text: "已保存", error: false });
                      }}
                    />
                  </section>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
      <Dialog
        open={clearDialogOpen}
        onOpenChange={(_, data) => {
          if (!busy) setClearDialogOpen(data.open);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>放弃当前采样记录？</DialogTitle>
            <DialogContent>
              清空后将无法恢复当前采样数据，是否放弃？
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setClearDialogOpen(false)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => void clearSamples()}
              >
                确认清空
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={modeDialogOpen}
        onOpenChange={(_, data) => {
          if (!busy) setModeDialogOpen(data.open);
        }}
      >
        <DialogSurface className="mode-dialog">
          <DialogBody>
            <DialogTitle>切换测试模式</DialogTitle>
            <DialogContent className="mode-dialog-content">
              <p className="dialog-intro">
                {bluetooth
                  ? "直接选择模式及精确参数回读请通过 USB 连接。"
                  : !snapshot.connected || !settings
                    ? "连接 USB 设备后可切换模式。"
                    : t?.running !== false
                      ? "停止负载并确认设备状态后可切换模式。"
                      : `当前模式：${mode[0]} · ${mode[1]}`}
              </p>
              {modeError && (
                <MessageBar intent="error">
                  <MessageBarBody>{modeError}</MessageBarBody>
                </MessageBar>
              )}
              <div className="mode-grid">
                {modes.map(([code, name, desc, unit], index) => (
                  <Card
                    className={`test-mode ${settings?.mode === index ? "active" : ""}`}
                    data-mode={code}
                    key={code}
                  >
                    <span className="test-mode-code">{code}</span>
                    <div>
                      <h2>{name}</h2>
                      <p>{desc}</p>
                    </div>
                    <Button
                      appearance={
                        settings?.mode === index ? "subtle" : "secondary"
                      }
                      disabled={!canSwitchMode || settings?.mode === index}
                      aria-label={`切换到 ${code}`}
                      onClick={() => void switchMode(index)}
                    >
                      {settings?.mode === index ? "已选中" : `切换到 ${code}`}
                    </Button>
                    <div className="test-mode-footer">
                      <span>
                        {index >= 4 && index <= 6
                          ? "专用测试"
                          : index === 9
                            ? "循环测试"
                            : `目标单位 · ${unit}`}
                      </span>
                      {settings?.mode === index && (
                        <Badge appearance="tint" color="brand">
                          当前模式
                        </Badge>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setModeDialogOpen(false)}>
                关闭
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={deviceDialog}
        onOpenChange={(_, d) => {
          if (!d.open) void closeDeviceDialog();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>连接设备</DialogTitle>
            <DialogContent>
              {deviceError && (
                <MessageBar intent="error">
                  <MessageBarBody>{deviceError}</MessageBarBody>
                </MessageBar>
              )}
              {native && (
                <TabList
                  selectedValue={connectionType}
                  aria-label="连接方式"
                  onTabSelect={(_, data) => {
                    const type = data.value as "usb" | "bluetooth";
                    if (type === connectionType) return;
                    void (async () => {
                      if (
                        type === "bluetooth" &&
                        !snapshot.connected &&
                        (rootUsb?.enabled || rootUsb?.restorePending)
                      ) {
                        if (!(await setRootHost(false))) return;
                      }
                      setScanError(null);
                      setConnectionType(type);
                      if (type === "bluetooth") void refreshBluetooth();
                    })();
                  }}
                >
                  <Tab
                    value="usb"
                    disabled={scanning || busy || rootBusy}
                    icon={<UsbPlug20Regular />}
                  >
                    USB
                  </Tab>
                  <Tab
                    value="bluetooth"
                    disabled={scanning || busy || rootBusy}
                    icon={<Bluetooth20Regular />}
                  >
                    蓝牙
                  </Tab>
                </TabList>
              )}
              {connectionType === "bluetooth" &&
                bluetoothState &&
                (!bluetoothState.supported ||
                  bluetoothState.enabled === false ||
                  !bluetoothState.permission) && (
                  <p className="dialog-intro">
                    {!bluetoothState.supported
                      ? "此设备不支持 BLE"
                      : bluetoothState.enabled === false
                        ? "系统蓝牙已关闭，请在系统设置中开启。"
                        : "请在系统弹窗允许附近设备访问。"}
                  </p>
                )}
              {connectionType === "usb" && rootUsb && (
                <div className="root-usb-control">
                  <Switch
                    label="Root USB-C 直连"
                    checked={rootUsb.enabled}
                    disabled={
                      rootBusy ||
                      scanning ||
                      busy ||
                      !rootUsb.supported ||
                      rootUsb.restorePending ||
                      (snapshot.connected && !rootUsb.enabled)
                    }
                    aria-describedby="root-usb-description"
                    onChange={(_, data) => void setRootHost(data.checked)}
                  />
                  <p id="root-usb-description">
                    {!rootUsb.supported
                      ? "此设备不支持 USB Host，无法使用 Root 直连。"
                      : rootUsb.enabled
                        ? "已启用。连接 BW150 后允许 USB 访问；断开设备或关闭此功能时恢复原 USB 角色。"
                        : "C-C 直连无法识别时可尝试启用。需要在 Root 管理器中授权本应用；普通 OTG 连接无需开启。"}
                  </p>
                  {rootBusy && (
                    <Spinner
                      size="tiny"
                      label="正在请求 Root 并切换 USB 角色…"
                    />
                  )}
                  {(rootError || rootUsb.error) && (
                    <MessageBar intent="error">
                      <MessageBarBody>
                        {rootError || rootUsb.error}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {rootUsb.restorePending && (
                    <div className="root-usb-recovery">
                      <p>上次 USB 角色尚未恢复，请先恢复后再连接。</p>
                      <Button
                        disabled={rootBusy || busy}
                        onClick={() => void setRootHost(false)}
                      >
                        恢复 USB 角色
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {scanning ? (
                <div className="dialog-empty">
                  <Spinner
                    label={
                      connectionType === "bluetooth"
                        ? "正在扫描 BW150 蓝牙设备…"
                        : "正在扫描 USB 设备…"
                    }
                  />
                </div>
              ) : visibleDevices.length ? (
                <div className="device-list">
                  {visibleDevices.map((d) => (
                    <div className="device-option" key={d.path}>
                      <div className="connection-icon">
                        {connectionType === "bluetooth" ? (
                          <Bluetooth20Regular />
                        ) : (
                          <UsbPlug20Regular />
                        )}
                      </div>
                      <div>
                        <strong>{d.name}</strong>
                        <span>
                          {connectionType === "bluetooth"
                            ? `${d.path.replace("ble://", "")} · ${d.rssi ?? "—"} dBm`
                            : `序列号 ${d.serial || "连接后读取"} · ${d.vendorId.toString(16).padStart(4, "0")}:${d.productId.toString(16).padStart(4, "0")}`}
                        </span>
                      </div>
                      <Button
                        appearance="primary"
                        disabled={
                          busy ||
                          rootBusy ||
                          !!rootUsb?.restorePending ||
                          (snapshot.connected &&
                            snapshot.device?.path === d.path)
                        }
                        onClick={() =>
                          void connectionTask(async () => {
                            try {
                              await api.connect(d.path);
                              setSamples([]);
                              setDeviceDialog(false);
                            } finally {
                              if (connectionType === "usb") await refresh();
                            }
                          })
                        }
                      >
                        {snapshot.connected && snapshot.device?.path === d.path
                          ? "已连接"
                          : "连接"}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : connectionType === "bluetooth" ? (
                <div className="dialog-empty">
                  <Bluetooth20Regular />
                  <strong>
                    {scanError ? "蓝牙扫描失败" : "未发现 BW150 蓝牙设备"}
                  </strong>
                  <span>
                    {scanError ||
                      "请确认 BW150 已供电并开启蓝牙，靠近手机后重新扫描。若其他应用已连接，请先断开。"}
                  </span>
                </div>
              ) : (
                <div className="dialog-empty">
                  <PlugDisconnected20Regular />
                  <strong>
                    {scanError
                      ? "扫描失败"
                      : usbDiagnostics && !usbDiagnostics.hostSupported
                        ? "此设备不支持 USB Host"
                        : usbDiagnostics?.devices.length === 0
                          ? "Android 尚未识别到 USB 外设"
                          : "未发现 ATORCH 设备"}
                  </strong>
                  <span>
                    {scanError
                      ? scanError
                      : !native
                        ? "当前为浏览器预览，请启动本机应用连接设备。"
                        : usbDiagnostics && !usbDiagnostics.hostSupported
                          ? "请使用支持 USB Host / OTG 的 Android 设备。"
                          : usbDiagnostics?.devices.length === 0
                            ? "请检查 OTG 连接、数据线与 BW150 供电。USB-C 直连无法识别时，可改用手机 OTG 转接头接 USB-A 数据线。"
                            : usbDiagnostics
                              ? "系统已识别 USB 外设，但没有匹配到 BW150。请确认连接的是设备的数据接口。"
                              : "请检查 USB 数据线与设备供电，然后重新扫描。"}
                  </span>
                  {usbDiagnostics?.hostSupported && (
                    <span>
                      系统已识别 {usbDiagnostics.devices.length} 个 USB 外设
                    </span>
                  )}
                  {!!usbDiagnostics?.devices.length && (
                    <ul className="usb-diagnostics">
                      {usbDiagnostics.devices.map((d) => (
                        <li key={d.path}>
                          {d.name} · {d.vendorId.toString(16).padStart(4, "0")}:
                          {d.productId.toString(16).padStart(4, "0")}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {connectionType === "usb" &&
                !scanning &&
                devices.length > 0 &&
                usbDiagnostics && (
                  <p className="dialog-intro">
                    点击连接后，请在 Android 系统弹窗中允许访问 USB 设备。
                  </p>
                )}
            </DialogContent>
            {snapshot.connected && (
              <DialogActions position="start">
                <Button
                  className="device-dialog-action"
                  icon={<PlugDisconnected20Regular />}
                  disabled={busy || rootBusy}
                  onClick={() =>
                    void connectionTask(async () => {
                      await api.disconnect();
                      await refresh();
                      setDeviceDialog(false);
                    })
                  }
                >
                  断开设备
                </Button>
              </DialogActions>
            )}
            <DialogActions position="end">
              <Button
                className="device-dialog-action"
                icon={
                  scanning ? <Spinner size="tiny" /> : <ArrowSync20Regular />
                }
                disabled={scanning || rootBusy || busy || !native}
                onClick={() =>
                  void (connectionType === "bluetooth"
                    ? refreshBluetooth()
                    : refresh())
                }
              >
                重新扫描
              </Button>
              <Button
                className="device-dialog-action"
                appearance="primary"
                disabled={rootBusy || busy}
                onClick={() => void closeDeviceDialog()}
              >
                关闭
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setConfirm(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogContent>
              <p>{confirm?.text}</p>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirm(null)}>取消</Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  if (c) void command(c.kind, c.value, c.expectedMode);
                }}
              >
                确认{confirm?.title}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  );
}
