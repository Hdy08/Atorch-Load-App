import type { BluetoothState, DeviceInfo, Snapshot } from "./types";

export type AutoConnectionPhase =
  "idle" | "usb" | "bluetooth" | "connecting" | "waiting";
export interface ConnectionApi {
  discover: () => Promise<DeviceInfo[]>;
  bluetoothStatus: () => Promise<BluetoothState | null>;
  discoverBluetooth: () => Promise<DeviceInfo[]>;
  stopBluetoothScan: () => Promise<void>;
  connect: (path: string) => Promise<void>;
  snapshot: () => Promise<Snapshot>;
}

/** One cancellable scan loop. Manual operations wait for its current call to settle. */
export class AutomaticConnection {
  private enabled = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private phase: AutoConnectionPhase = "idle";
  private permissionRequested = false;
  private failures = new Map<string, number>();
  private readonly api: ConnectionApi;
  private readonly onPhase: (phase: AutoConnectionPhase) => void;
  private readonly onConnected: (snapshot: Snapshot) => void;
  private readonly delays: { initial: number; retry: number };

  constructor(
    api: ConnectionApi,
    onPhase: (phase: AutoConnectionPhase) => void,
    onConnected: (snapshot: Snapshot) => void,
    delays = { initial: 1500, retry: 5000 },
  ) {
    this.api = api;
    this.onPhase = onPhase;
    this.onConnected = onConnected;
    this.delays = delays;
  }

  private update(phase: AutoConnectionPhase) {
    this.phase = phase;
    this.onPhase(phase);
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return this.task ?? Promise.resolve();
    this.enabled = enabled;
    ++this.generation;
    clearTimeout(this.timer);
    if (enabled) {
      if (!this.task) this.schedule(this.delays.initial);
      return Promise.resolve();
    }
    // Cancel only our BLE scan; a subsequent manual scan starts after draining.
    const stopped =
      this.phase === "bluetooth"
        ? this.api.stopBluetoothScan().catch(() => {})
        : Promise.resolve();
    return Promise.all([stopped, this.task]).then(() => {
      if (!this.enabled) this.update("idle");
    });
  }

  private schedule(delay: number) {
    if (!this.enabled) return;
    this.update("waiting");
    this.timer = setTimeout(() => {
      const generation = this.generation;
      this.task = this.cycle(generation)
        .catch(() => {})
        .finally(() => {
          this.task = undefined;
          if (this.enabled) this.schedule(this.delays.retry);
          else this.update("idle");
        });
    }, delay);
  }

  private current(generation: number) {
    return this.enabled && generation === this.generation;
  }

  private async connectCandidates(devices: DeviceInfo[], generation: number) {
    for (const device of devices) {
      if (!this.current(generation)) return false;
      // APP and IAP share the USB VID/PID; never poll an upgrade interface.
      if (
        device.serial?.toUpperCase() === "IAP" ||
        /\bIAP\b/i.test(device.name) ||
        (this.failures.get(device.path) ?? 0) > Date.now()
      )
        continue;
      const before = await this.api.snapshot();
      if (!this.current(generation) || before.firmware?.active) return false;
      if (before.connected) return true;
      this.update("connecting");
      try {
        await this.api.connect(device.path);
        const next = await this.api.snapshot();
        if (next.connected) {
          this.enabled = false;
          this.onConnected(next);
          return true;
        }
      } catch {
        this.failures.set(device.path, Date.now() + 30_000);
        // Try the next compatible device, then the other transport.
      }
    }
    return false;
  }

  private async usb(generation: number) {
    if (!this.current(generation)) return false;
    this.update("usb");
    const devices = await this.api.discover().catch(() => []);
    return this.connectCandidates(devices, generation);
  }

  private async cycle(generation: number) {
    const state = await this.api.snapshot();
    if (!this.current(generation) || state.connected || state.firmware?.active)
      return;
    if (await this.usb(generation)) return;
    if (!this.current(generation)) return;
    const status = await this.api.bluetoothStatus();
    if (
      !this.current(generation) ||
      !status?.supported ||
      status.enabled === false ||
      (status.locationRequired && !status.locationEnabled)
    )
      return;
    // Offer the system permission prompt once. Denial never causes repeated popups.
    if (!status.permission) {
      if (this.permissionRequested) return;
      this.permissionRequested = true;
    }
    this.update("bluetooth");
    const devices = await this.api.discoverBluetooth().catch(() => []);
    if (!this.current(generation)) return;
    // A USB device may have arrived during the six-second BLE scan.
    if (await this.usb(generation)) return;
    await this.connectCandidates(devices, generation);
  }
}
