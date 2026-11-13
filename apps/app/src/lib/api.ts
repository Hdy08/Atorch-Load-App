import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  BluetoothState,
  BleAction,
  BleCommandResult,
  DeviceInfo,
  RootUsbState,
  Snapshot,
  RecordingInfo,
  CsvDocument,
  Telemetry,
  UsbDiagnostics,
  PromptContext,
  FirmwareInfo,
  FirmwareRehearsal,
} from "./types";
import { emptySnapshot } from "./types";
export const native = isTauri();
export const api = {
  discover: () =>
    native ? invoke<DeviceInfo[]>("discover_devices") : Promise.resolve([]),
  usbDiagnostics: () =>
    native
      ? invoke<UsbDiagnostics | null>("get_usb_diagnostics")
      : Promise.resolve(null),
  bluetoothStatus: () =>
    native
      ? invoke<BluetoothState | null>("get_bluetooth_status")
      : Promise.resolve(null),
  discoverBluetooth: () => invoke<DeviceInfo[]>("discover_bluetooth"),
  stopBluetoothScan: () => invoke<void>("stop_bluetooth_scan"),
  rootUsbHost: (enabled: boolean) =>
    invoke<RootUsbState>("set_root_usb_host", { enabled }),
  connect: (path: string) => invoke<void>("connect_device", { path }),
  disconnect: () => invoke<void>("disconnect_device"),
  snapshot: () =>
    native ? invoke<Snapshot>("get_snapshot") : Promise.resolve(emptySnapshot),
  history: () =>
    native ? invoke<Telemetry[]>("get_history") : Promise.resolve([]),
  command: (
    kind: string,
    value: number,
    expectedMode?: number,
    expectedPrompt?: PromptContext,
  ) =>
    invoke<void>("send_command", {
      command: { kind, value, expectedMode, expectedPrompt },
    }),
  bleCommand: (action: BleAction) =>
    invoke<BleCommandResult>("send_ble_command", { action }),
  inspectFirmware: (name: string, dataBase64: string) =>
    invoke<FirmwareInfo>("inspect_firmware", { name, dataBase64 }),
  rehearseFirmware: (name: string, dataBase64: string) =>
    invoke<FirmwareRehearsal>("rehearse_firmware", { name, dataBase64 }),
  startFirmware: (path: string, name: string, dataBase64: string) =>
    invoke<void>("start_firmware", { path, name, dataBase64 }),
  cancelFirmware: () => invoke<void>("cancel_firmware"),
  record: (enabled: boolean) => invoke<void>("set_recording", { enabled }),
  sampling: (enabled: boolean) => invoke<void>("set_sampling", { enabled }),
  usbSampleRate: (hz: number) => invoke<void>("set_usb_sample_rate", { hz }),
  clearSamples: () => invoke<void>("clear_samples"),
  saveCsv: (name: string, content: string) =>
    invoke<string | null>("save_csv", { name, content }),
  savePng: (name: string, dataUrl: string) =>
    invoke<string | null>("save_png", { name, dataUrl }),
  recordings: () =>
    native ? invoke<RecordingInfo[]>("list_recordings") : Promise.resolve([]),
  openCsv: () => invoke<CsvDocument | null>("open_csv"),
  registerRecording: (path: string) =>
    invoke<RecordingInfo>("register_recording", { path }),
  readRecording: (id: string) => invoke<CsvDocument>("read_recording", { id }),
  deleteRecordings: (ids: string[]) =>
    invoke<void>("delete_recordings", { ids }),
};
