import { NumericInput } from "./components/NumericInput";
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
  Nav,
  NavItem,
  Spinner,
  Switch,
  Tab,
  TabList,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowDownload20Regular,
  ArrowSync20Regular,
  Bluetooth20Regular,
  CheckmarkCircle20Regular,
  PulseSquare20Regular,
  PulseSquare20Filled,
  Delete20Regular,
  DocumentTable20Regular,
  DocumentTable20Filled,
  FolderOpen20Regular,
  Pause20Filled,
  Play20Filled,
  PlugConnected20Regular,
  PlugConnected20Filled,
  PlugDisconnected20Regular,
  PlugDisconnected20Filled,
  Settings20Regular,
  Settings20Filled,
  ShieldCheckmark20Regular,
  UsbPlug20Regular,
  WindowSettings20Regular,
  WindowSettings20Filled,
  bundleIcon,
} from "@fluentui/react-icons";
import { api, native } from "./lib/api";
import { accentTheme, measurementColor } from "./lib/theme";
import { readAppearance, useAppearance } from "./lib/appearance";
import { readAutoConnectPreference } from "./lib/autoConnect";
import { defaultAutoRecording } from "./lib/autoRecording";
import {
  ApplicationSettings,
  settingsForm,
  type ApplicationTab,
} from "./components/ApplicationSettings";
import { download, exportCsv } from "./lib/csv";
import { importCsv } from "./lib/csvImport";
import { Notification, Notifications } from "./components/Notifications";
import {
  readChartSelection,
  readSharedChartBounds,
  type ChartBounds,
} from "./lib/analysis";
import { DataReview } from "./components/DataReview";
import { ChartTimeSelect } from "./components/ChartTimeSelect";
import { MenuSelect } from "./components/MenuSelect";
import { ChartAction } from "./components/ChartAction";
import { readChartTimeMode, sampleElapsedMs } from "./lib/chartTime";
import { completeRecordCounters } from "./lib/records";
import { cacheDeviceMeasurementPrecision } from "./lib/measurementFormat";
import { useAutoConnect } from "./lib/useAutoConnect";
import { SpecialTests } from "./components/SpecialTests";
import {
  FirmwareNotification,
  FirmwarePanel,
} from "./components/FirmwarePanel";
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
import { WindowTitlebar } from "./components/WindowTitlebar";
import {
  FloatingLoadControl,
  type ControlPosition,
} from "./components/FloatingLoadControl";
import { usePageLayout } from "./lib/usePageLayout";
import { usePageTransition } from "./lib/usePageTransition";
import { useNavigationIndicator } from "./lib/useNavigationIndicator";
import { usePageScrollbar } from "./lib/usePageScrollbar";

type Page = "live" | "history" | "settings" | "firmware" | "application";
const nav = [
  ["live", "实时监控", bundleIcon(PulseSquare20Filled, PulseSquare20Regular)],
  [
    "history",
    "数据记录",
    bundleIcon(DocumentTable20Filled, DocumentTable20Regular),
  ],
  ["settings", "设备设置", bundleIcon(Settings20Filled, Settings20Regular)],
  [
    "application",
    "应用设置",
    bundleIcon(WindowSettings20Filled, WindowSettings20Regular),
  ],
] as const;
const ConnectedIcon = bundleIcon(PlugConnected20Filled, PlugConnected20Regular);
const DisconnectedIcon = bundleIcon(
  PlugDisconnected20Filled,
  PlugDisconnected20Regular,
);
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
          <NumericInput
            aria-label={label}

            value={text}
            placeholder="—"
            min={min}
            max={max}
            step={step}
            precision={fractionDigits}
            disabled={disabled || busy}
            onChange={(_, d) => setText(d.value)}
            unit={unit}
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

function MetricCard({
  measurement,
  title,
  value,
  unit,
  digits,
  color,
}: {
  measurement: SeriesKey;
  title: string;
  value: number | null | undefined;
  unit: string;
  digits: number;
  color: string;
}) {
  return (
    <Card className="metric" aria-label={title} data-measurement={measurement}>
      <div className="metric-title">
        <h2>{title}</h2>
        <span className="metric-symbol" style={{ color }}>
          {unit}
        </span>
      </div>
      <div className="metric-value mono" style={{ color }}>
        <span className="metric-number">{fmt(value, digits)}</span>
        <span className="metric-unit">{unit}</span>
      </div>
    </Card>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("live");
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [modeError, setModeError] = useState("");
  const [loadTab, setLoadTab] = useState("quick");
  const [applicationTab, setApplicationTab] =
    useState<ApplicationTab>("appearance");
  const [customTitlebar, setCustomTitlebar] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [appearance, setAppearance] = useState(readAppearance);
  const {
    dark,
    scale,
    mobileDevice,
    mobileLayout,
    collapsed,
    accent,
    systemAccent,
    applyAppearance,
  } = useAppearance(appearance, setAppearance);
  const layout = usePageLayout(
    appRef,
    page,
    customTitlebar,
    scale,
    mobileLayout,
    collapsed,
  );
  useNavigationIndicator(appRef, page, mobileLayout, scale);
  usePageScrollbar(appRef);
  const [controlPosition, setControlPosition] =
    useState<ControlPosition | null>(null);
  const pageTransition = appearance.transition;
  usePageTransition(mainRef, page, pageTransition);
  const theme = useMemo(() => accentTheme(dark, accent), [dark, accent]);
  const [autoConnectPreference, setAutoConnectPreference] = useState(
    readAutoConnectPreference,
  );
  useEffect(() => {
    localStorage.setItem("atorch-auto-connect", autoConnectPreference);
  }, [autoConnectPreference]);
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
  const [autoConnectionPaused, setAutoConnectionPaused] = useState(false);
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
      autoConnectPreference !== "off" &&
      !autoConnectionPaused &&
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
    autoConnectPreference,
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
  const deviceError = connectionError || snapshot.error;
  const deviceName =
    snapshot.device?.name.replace(/^ATORCH\s+/i, "").trim() ?? "";
  const deviceConnected = !!deviceName && snapshot.connected && !deviceError;
  const deviceStatus = !deviceName
    ? "未连接"
    : deviceError
      ? "异常"
      : snapshot.connected
        ? bluetooth
          ? "BLE"
          : "USB"
        : "未连接";
  const visibleDevices =
    connectionType === "bluetooth" ? bluetoothDevices : devices;
  const mode = modes[settings?.mode ?? 0] ?? [
    "UNKNOWN",
    "未知模式",
    "请读取设备模式",
    "",
  ];
  const basicMode = !!settings && settings.mode <= 3;
  useEffect(() => {
    if ((settings && !basicMode) || bluetooth) setLoadTab("modes");
  }, [settings?.mode, basicMode, bluetooth]);
  const startableMode = !!settings && settings.mode <= 8;
  const stagePending =
    !!snapshot.specialTest?.reading.prompt &&
    snapshot.specialTest.reading.mode === settings?.mode;
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
        setLoadDialogOpen(false);
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
            if (alive && epoch === historyEpoch.current) {
              cacheDeviceMeasurementPrecision(history, next.device?.transport);
              setSamples(history);
            }
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
    let current = true;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.style.backgroundColor =
      theme.colorNeutralBackground2;
    if (native)
      void api
        .windowTheme(
          dark,
          theme.colorNeutralBackground3,
          theme.colorNeutralForeground1,
          appearance.theme === "system",
        )
        .then((custom) => {
          if (current) setCustomTitlebar(!!custom);
        })
        .catch((error) => console.warn("窗口主题同步失败", error));
    return () => {
      current = false;
    };
  }, [dark, theme, appearance.theme]);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("has-window-titlebar", customTitlebar);
    return () => root.classList.remove("has-window-titlebar");
  }, [customTitlebar]);
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
      <Notifications
        message={message}
        loadControlVisible={page === "live"}
        layout={layout}
      >
        <FirmwareNotification job={snapshot.firmware} />
        <div
          ref={appRef}
          className={`app${customTitlebar ? " custom-titlebar" : ""}${mobileDevice ? " mobile-device" : ""}${mobileLayout ? " mobile-layout" : ""}${collapsed ? " sidebar-collapsed" : ""}`}
        >
          {customTitlebar && <WindowTitlebar />}
          {page === "live" && (
            <FloatingLoadControl
              snapshot={snapshot}
              busy={busy}
              layout={layout}
              position={controlPosition}
              onPositionChange={setControlPosition}
              onBleTask={run}
              runDisabled={
                !snapshot.connected ||
                bluetooth ||
                busy ||
                !t ||
                !settings ||
                (!t.running && (!startableMode || stagePending))
              }
              runLabel={
                bluetooth
                  ? "蓝牙暂不支持启停"
                  : t?.running
                    ? "停止负载"
                    : stagePending
                      ? "请先处理阶段选择"
                      : basicMode || !settings
                        ? "启动负载"
                        : startableMode
                          ? "启动专用测试"
                          : "请在设备面板启动测试"
              }
              onSettings={() => {
                setModeError("");
                setLoadTab(
                  basicMode || (!settings && !bluetooth) ? "quick" : "modes",
                );
                setLoadDialogOpen(true);
              }}
              onApply={(value) => applyLoadParameter("target", value)}
              onToggle={() => {
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
            />
          )}
          <aside className="sidebar">
            <Nav
              className="app-navigation"
              role="navigation"
              aria-label="主导航"
              selectedValue={page === "firmware" ? "settings" : page}
              onNavItemSelect={(_, data) => {
                if (data.value === "device") setDeviceDialog(true);
                else if (nav.some(([id]) => id === data.value))
                  setPage(data.value as Page);
              }}
            >
              {nav.map(([id, label, Icon]) => (
                <NavItem
                  key={id}
                  value={id}
                  aria-label={label}
                  aria-current={
                    page === id || (id === "settings" && page === "firmware")
                      ? "page"
                      : undefined
                  }
                  className="nav-item"
                  icon={{ children: <Icon />, className: "nav-item-icon" }}
                >
                  <span className="nav-item-label">{label}</span>
                </NavItem>
              ))}
              <section className="sidebar-device" aria-label="设备连接">
                <div className="device-info">
                  <div className="small-label">当前设备</div>
                  <div className="sidebar-device-name">
                    {deviceName && (
                      <>
                        <strong>{deviceName}</strong>{" "}
                      </>
                    )}
                    <span
                      className={`device-connection-status ${deviceConnected ? "connected" : "disconnected"}`}
                      id="device-connection-status"
                      role="status"
                    >
                      ({deviceStatus})
                    </span>
                  </div>
                </div>
                <NavItem
                  value="device"
                  className="nav-item device-manager-button"
                  disabled={busy}
                  aria-label={snapshot.connected ? "管理设备" : "连接设备"}
                  aria-describedby="device-connection-status"
                  icon={{
                    className: "nav-item-icon",
                    children: snapshot.connected ? (
                      <ConnectedIcon />
                    ) : (
                      <DisconnectedIcon />
                    ),
                  }}
                >
                  <span className="device-manager-label nav-item-label">
                    {snapshot.connected ? "管理设备" : "连接设备"}
                  </span>
                </NavItem>
              </section>
            </Nav>
            <span className="mobile-nav-indicator" aria-hidden="true" />
          </aside>
          <div className="main-shell">
            <main
              ref={mainRef}
              data-page={page}
              data-page-transition={pageTransition}
            >
              <div
                className={`page-heading${page === "live" ? " with-load-control" : ""}`}
              >
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
                {page === "application" && (
                  <div className="application-settings-actions">
                    <Button
                      type="reset"
                      form={settingsForm(applicationTab)}
                      disabled={busy}
                    >
                      恢复默认
                    </Button>
                    <Button
                      type="submit"
                      form={settingsForm(applicationTab)}
                      appearance="primary"
                      disabled={
                        busy ||
                        (applicationTab === "recording" &&
                          (!native || !snapshotReady))
                      }
                    >
                      应用更改
                    </Button>
                  </div>
                )}
                {page === "live" && (
                  <span
                    className="load-control-placeholder"
                    aria-hidden="true"
                  />
                )}
              </div>
              {!native && (
                <Notification
                  intent="info"
                  text="界面预览模式。USB 设备连接与控制请使用 Windows 或 Android 应用；这里可以导入历史 CSV 数据。"
                />
              )}
              <Notification text={snapshot.recordingError} error />

              {page === "live" && (
                <>
                  <div className="metrics">
                    {(
                      [
                        ["voltage", "电压", t?.voltage, "V", 3],
                        ["current", "电流", t?.current, "A", 3],
                        ["power", "功率", t?.power, "W", 3],
                        ["resistance", "电阻", t?.resistance, "Ω", 3],
                        ["energy", "电量", t?.energy, "Wh", 3],
                        [
                          "capacity",
                          "容量",
                          t?.capacity,
                          "mAh",
                          bluetooth ? 0 : 3,
                        ],
                      ] as const
                    ).map(([key, title, value, unit, digits]) => (
                      <MetricCard
                        key={key}
                        measurement={key}
                        title={title}
                        value={value}
                        unit={unit}
                        digits={digits}
                        color={
                          chartBounds[key]?.color ??
                          measurementColor(theme, key)
                        }
                      />
                    ))}
                  </div>
                  <Card className="chart-card">
                    <div className="section-head">
                      <div>
                        <h2>实时曲线</h2>
                      </div>
                      <div className="chart-toolbar">
                        {!bluetooth && (
                          <MenuSelect
                            aria-label="USB 采样率"
                            value={snapshot.usbSampleRateHz ?? 1}
                            disabled={!native || busy}
                            onChange={(value) => {
                              const hz = Number(value);
                              void run(async () => {
                                await api.usbSampleRate(hz);
                                setSnapshot(await api.snapshot());
                              });
                            }}
                            options={[1, 2, 5].map((hz) => ({
                              value: hz,
                              label: `${hz} Hz 采样`,
                            }))}
                          />
                        )}
                        <ChartTimeSelect
                          value={chartTimeMode}
                          onChange={setChartTimeMode}
                        />
                        <MenuSelect
                          aria-label="曲线时间范围"
                          value={range}
                          onChange={setRange}
                          options={[
                            { value: "60", label: "最近 1 分钟" },
                            { value: "300", label: "最近 5 分钟" },
                            { value: "1800", label: "最近 30 分钟" },
                            { value: "all", label: "全部数据" },
                          ]}
                        />
                      </div>
                    </div>
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
                      onSelectionChange={setSelected}
                      theme={theme}
                      bounds={chartBounds}
                      onImage={saveImage}
                      imageBusy={busy}
                      footerActions={
                        <div className="record-actions">
                          <ChartAction
                            label={snapshot.samplingPaused ? "继续" : "暂停"}
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
                          />
                          <ChartAction
                            label="清空"
                            icon={<Delete20Regular />}
                            disabled={busy}
                            onClick={() => {
                              if (samples.length || snapshot.sampleCount)
                                setClearDialogOpen(true);
                              else void clearSamples();
                            }}
                          />
                        </div>
                      }
                      exportAction={(rows, getCurrentRows) => (
                        <ChartAction
                          label="导出"
                          icon={<ArrowDownload20Regular />}
                          disabled={!rows.length || busy}
                          onClick={() => saveRows(getCurrentRows())}
                        />
                      )}
                    />
                  </Card>
                  <div
                    className="metrics thermal-metrics"
                    aria-label="温度与散热"
                  >
                    {(
                      [
                        [
                          "cpuTemperature",
                          "CPU 温度",
                          t?.cpuTemperature,
                          "°C",
                          1,
                        ],
                        [
                          "mosTemperature",
                          "MOS 温度",
                          t?.mosTemperature,
                          "°C",
                          1,
                        ],
                        [
                          "ntcTemperature",
                          "NTC 温度",
                          t?.ntcTemperature,
                          "°C",
                          1,
                        ],
                        ["fanSpeed", "风扇转速", t?.fanSpeed, "RPM", 0],
                      ] as const
                    ).map(([key, title, value, unit, digits]) => (
                      <MetricCard
                        key={key}
                        measurement={key}
                        title={title}
                        value={value}
                        unit={unit}
                        digits={digits}
                        color={
                          chartBounds[key]?.color ??
                          measurementColor(theme, key)
                        }
                      />
                    ))}
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
                        导入
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
                                  files.filter(
                                    (file) => !ids.includes(file.id),
                                  ),
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
                      <Notification text={archiveError} error />
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
                                {archiveId === file.id
                                  ? "重新载入"
                                  : "打开记录"}
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
                          "mosLimit",
                          "ntcLimit",
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
                          min={
                            key === "temperatureCalibration" ? 0.5 : undefined
                          }
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
                <ApplicationSettings
                  tab={applicationTab}
                  onTabChange={setApplicationTab}
                  appearance={appearance}
                  onAppearanceChange={applyAppearance}
                  systemAccent={systemAccent}
                  theme={theme}
                  chartBounds={chartBounds}
                  onChartChange={setChartBounds}
                  connection={autoConnectPreference}
                  onConnectionChange={setAutoConnectPreference}
                  recording={
                    snapshot.autoRecording ??
                    defaultAutoRecording(snapshot.autoRecordOnLoad)
                  }
                  recordingDisabled={!native || !snapshotReady || busy}
                  busy={busy}
                  onRecordingChange={(settings) =>
                    run(async () => {
                      await api.autoRecording(settings);
                      setSnapshot(await api.snapshot());
                    }, "已保存")
                  }
                />
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
                <Button
                  disabled={busy}
                  onClick={() => setClearDialogOpen(false)}
                >
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
          open={loadDialogOpen}
          onOpenChange={(_, data) => {
            if (!busy) setLoadDialogOpen(data.open);
          }}
        >
          <DialogSurface
            className={`mode-dialog load-control-dialog control-card ${loadTab === "quick" ? "quick-settings-dialog" : ""}`}
          >
            <DialogBody>
              <DialogTitle>负载控制</DialogTitle>
              <DialogContent className="mode-dialog-content">
                <TabList
                  aria-label="负载控制设置"
                  selectedValue={loadTab}
                  onTabSelect={(_, data) => setLoadTab(String(data.value))}
                >
                  {(basicMode || (!settings && !bluetooth)) && (
                    <Tab value="quick">快速设定</Tab>
                  )}
                  <Tab value="modes">模式切换</Tab>
                </TabList>
                {loadTab === "quick" &&
                (basicMode || (!settings && !bluetooth)) ? (
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
                        disabled={!snapshot.connected || busy || !settings}
                        onApply={(value) => applyLoadParameter(kind, value)}
                      />
                    ))}
                    <LoadTimeLimit
                      hours={settings?.limitHours}
                      minutes={settings?.limitMinutes}
                      disabled={!snapshot.connected || busy || !settings}
                      onApply={applyTimeLimit}
                    />
                    {(["mosLimit", "ntcLimit"] as const).map((kind) => (
                      <LoadParameter
                        key={kind}
                        range={loadParameterRange(kind, loadSettings)}
                        value={settings?.[kind]}
                        disabled={!snapshot.connected || busy || !settings}
                        onApply={(value) => applyLoadParameter(kind, value)}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    {(!snapshot.connected ||
                      !settings ||
                      bluetooth ||
                      t?.running !== false) && (
                      <p className="dialog-intro">
                        {bluetooth
                          ? "直接选择模式及精确参数回读请通过 USB 连接。"
                          : !snapshot.connected || !settings
                            ? "连接 USB 设备后可切换模式。"
                            : t?.running !== false
                              ? "停止负载并确认设备状态后可切换模式。"
                              : ""}
                      </p>
                    )}
                    <Notification text={modeError} error />
                    <div className="mode-grid">
                      {modes.map(([code, name, desc], index) => (
                        <Tooltip
                          key={code}
                          content={desc}
                          relationship="description"
                        >
                          <Card
                            className={`test-mode ${settings?.mode === index ? "active" : ""}`}
                            data-mode={code}
                            role="button"
                            focusMode="off"
                            tabIndex={
                              canSwitchMode && settings?.mode !== index ? 0 : -1
                            }
                            aria-label={`切换到 ${code}`}
                            aria-pressed={settings?.mode === index}
                            disabled={
                              !canSwitchMode || settings?.mode === index
                            }
                            onClick={() => void switchMode(index)}
                            onKeyDown={(event) => {
                              if (
                                (event.key === "Enter" || event.key === " ") &&
                                canSwitchMode &&
                                settings?.mode !== index
                              ) {
                                event.preventDefault();
                                void switchMode(index);
                              }
                            }}
                          >
                            <span className="test-mode-code">{code}</span>
                            <h2>{name}</h2>
                          </Card>
                        </Tooltip>
                      ))}
                    </div>
                  </>
                )}
              </DialogContent>
              <DialogActions>
                <Button
                  disabled={busy}
                  onClick={() => setLoadDialogOpen(false)}
                >
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
                <Notification text={deviceError} error />
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
                    <Notification text={rootError || rootUsb.error} error />
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
                                setAutoConnectionPaused(false);
                                setSamples([]);
                                setDeviceDialog(false);
                              } finally {
                                if (connectionType === "usb") await refresh();
                              }
                            })
                          }
                        >
                          {snapshot.connected &&
                          snapshot.device?.path === d.path
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
                    {!scanError && (!native || usbDiagnostics) && (
                      <span>
                        {!native
                          ? "当前为浏览器预览，请启动本机应用连接设备。"
                          : usbDiagnostics && !usbDiagnostics.hostSupported
                            ? "请使用支持 USB Host / OTG 的 Android 设备。"
                            : usbDiagnostics?.devices.length === 0
                              ? "请检查 OTG 连接、数据线与 BW150 供电。USB-C 直连无法识别时，可改用手机 OTG 转接头接 USB-A 数据线。"
                              : usbDiagnostics
                                ? "系统已识别 USB 外设，但没有匹配到 BW150。请确认连接的是设备的数据接口。"
                                : null}
                      </span>
                    )}
                    {usbDiagnostics?.hostSupported && (
                      <span>
                        系统已识别 {usbDiagnostics.devices.length} 个 USB 外设
                      </span>
                    )}
                    {!!usbDiagnostics?.devices.length && (
                      <ul className="usb-diagnostics">
                        {usbDiagnostics.devices.map((d) => (
                          <li key={d.path}>
                            {d.name} ·{" "}
                            {d.vendorId.toString(16).padStart(4, "0")}:
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
                    onClick={() => {
                      setAutoConnectionPaused(true);
                      void connectionTask(async () => {
                        await api.disconnect();
                        await refresh();
                        setDeviceDialog(false);
                      });
                    }}
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
        <Notification text={scanError} error />
      </Notifications>
    </FluentProvider>
  );
}
