import type { AutoRecordingSettings } from "./autoRecording";
export interface DeviceInfo {
  path: string;
  name: string;
  serial: string;
  vendorId: number;
  productId: number;
  transport?: "usb" | "bluetooth";
  rssi?: number;
}
export interface BluetoothState {
  supported: boolean;
  enabled: boolean | null;
  permission: boolean;
  locationRequired: boolean;
  locationEnabled: boolean;
}
export type BleAction =
  | "keySet"
  | "keyOk"
  | "keyPlus"
  | "keyMinus"
  | "clearEnergy"
  | "clearCapacity"
  | "clearTime";
export interface BleCommandResult {
  action: BleAction;
  sentAt: number;
  deviceConfirmed: boolean;
  message: string;
}
export interface UsbDiagnostics {
  hostSupported: boolean;
  rootUsb?: RootUsbState | null;
  devices: {
    path: string;
    name: string;
    vendorId: number;
    productId: number;
    supported: boolean;
    permission: boolean;
  }[];
}
export interface RootUsbState {
  supported: boolean;
  enabled: boolean;
  restorePending: boolean;
  error: string | null;
}
export interface Telemetry {
  timestamp: number;
  elapsedMs?: number;
  segmentId?: number;
  energyCalculated?: boolean;
  capacityCalculated?: boolean;
  voltage: number;
  current: number;
  power: number;
  energy: number | null;
  capacity: number | null;
  resistance: number | null;
  cpuTemperature: number | null;
  ntcTemperature: number | null;
  mosTemperature: number | null;
  fanSpeed: number | null;
  running: boolean | null;
  status: number;
  stageCode?: number | null;
}
export interface DeviceSettings {
  cutoffVoltage: number;
  target: number | null;
  voltageCalibration: number;
  currentCalibration: number;
  temperatureCalibration: number;
  fullVoltage: number;
  cutoffCurrent: number;
  overCurrent: number;
  overPower: number;
  ntcLimit: number;
  mosLimit: number;
  mode: number;
  language: number;
  brightness: number;
  standbyBrightness: number;
  standbySeconds: number;
  limitHours: number;
  limitMinutes: number;
  cycleCount?: number;
}
export interface LoadLimits {
  voltage: number;
  current: number;
  power: number;
}
export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
}
export interface RecordingInfo {
  id: string;
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}
export interface CsvDocument {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
  dataBase64: string;
}
export interface Snapshot {
  connected: boolean;
  device: DeviceInfo | null;
  telemetry: Telemetry | null;
  settings: DeviceSettings | null;
  loadLimits?: LoadLimits;
  sampleCount: number;
  samplingPaused?: boolean;
  samplingElapsedMs?: number;
  usbSampleRateHz?: 1 | 2 | 5;
  autoRecordOnLoad?: boolean;
  autoRecording?: AutoRecordingSettings;
  connectedAt: number;
  lastReportAt: number;
  recording: string | null;
  recordingPaused?: boolean;
  recordingError?: string | null;
  error: string | null;
  logs: LogEntry[];
  specialTest?: SpecialTest | null;
  specialResults?: SpecialResult[];
  firmware?: FirmwareStatus | null;
}
export interface FirmwareStatus {
  active: boolean;
  cancellable: boolean;
  phase: string;
  acknowledgedBlocks: number;
  blocks: number;
  bytes: number;
  sha256: string;
  message: string;
  startedAt: number;
  finishedAt: number | null;
  logPath: string;
  flashConfirmed: boolean;
  restoredDevice: DeviceInfo | null;
}
export interface PromptContext {
  status: number;
  code: number;
}
export interface StageAction {
  value: number;
  label: string;
  clearsData: boolean;
}
export interface StagePrompt {
  context: PromptContext;
  kind: number;
  selection: number;
  actions: StageAction[];
}
export interface SpecialReading {
  mode: number;
  timestamp: number;
  running: boolean | null;
  status: number;
  stageCode: number | null;
  prompt: StagePrompt | null;
  voltage: number;
  current: number;
  power: number;
  resistance: number | null;
  energy: number | null;
  capacity: number;
}
export interface SpecialTest {
  reading: SpecialReading;
  startedAt: number | null;
  observedStart: boolean;
  peakPower: number | null;
  peakCurrent: number | null;
}
export interface SpecialResult {
  mode: number;
  startedAt: number | null;
  stoppedAt: number;
  observedStart: boolean;
  peakPower: number | null;
  peakCurrent: number | null;
  lastRunning: SpecialReading;
  stopped: SpecialReading;
}
export interface FirmwareInfo {
  name: string;
  bytes: number;
  sha256: string;
  crc16: string;
  family: string;
  filenameModel: string | null;
  blocks: number;
  lastBlockBytes: number;
  remainder: number;
  handshakeHex: string;
  firstBlockHex: string;
  lastBlockHex: string;
  bootEntryHex: string;
  hardwareWriteAvailable: boolean;
  limitation: string;
}
export interface FirmwareRehearsal {
  offline: boolean;
  phase: string;
  blocks: number;
  acknowledgedBlocks: number;
  transferredBytes: number;
  events: string[];
}
export const emptySnapshot: Snapshot = {
  connected: false,
  device: null,
  telemetry: null,
  settings: null,
  sampleCount: 0,
  connectedAt: 0,
  lastReportAt: 0,
  recording: null,
  error: null,
  logs: [],
};
export const modes = [
  ["CC", "恒流模式", "保持设定电流，用于电源与电池放电测试", "A"],
  ["CV", "恒压模式", "保持设定电压，测试电源限流特性", "V"],
  ["CR", "恒阻模式", "模拟固定电阻负载", "Ω"],
  ["CP", "恒功率模式", "保持设定功率，评估输出能力", "W"],
  ["IR", "内阻测试", "测量电池或电源的内阻", "Ω"],
  ["POWER", "电源测试", "评估电源的输出性能", "W"],
  ["CABLE", "线材测试", "测量线缆压降与电阻", "Ω"],
  ["CDC", "充放充测试", "设备端依次执行充电、放电、充电三个阶段", "A"],
  ["CDCDC", "充放充放充测试", "设备端依次执行五个充放电阶段", "A"],
  ["CDxn", "多次循环", "设备端执行多次充放电测试", "A"],
] as const;
