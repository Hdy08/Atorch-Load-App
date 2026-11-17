export type RecordingParameter = "voltage" | "current" | "power";
export type RecordingComparison = "less" | "greater";
export interface DeviceRecordingRule {
  enabled: boolean;
  delaySeconds: number;
}
export interface ThresholdRecordingRule {
  enabled: boolean;
  parameter: RecordingParameter;
  comparison: RecordingComparison;
  value: number;
  holdSeconds: number;
}
export interface AutoRecordingSettings {
  mode: "off" | "device" | "threshold";
  startOnLoad: DeviceRecordingRule;
  stopOnLoad: DeviceRecordingRule;
  startThreshold: ThresholdRecordingRule;
  stopThreshold: ThresholdRecordingRule;
}
export function defaultAutoRecording(legacy = false): AutoRecordingSettings {
  return {
    mode: legacy ? "device" : "off",
    startOnLoad: { enabled: true, delaySeconds: 0 },
    stopOnLoad: { enabled: true, delaySeconds: 0 },
    startThreshold: {
      enabled: false,
      parameter: "voltage",
      comparison: "greater",
      value: 0,
      holdSeconds: 0,
    },
    stopThreshold: {
      enabled: false,
      parameter: "voltage",
      comparison: "less",
      value: 0,
      holdSeconds: 0,
    },
  };
}
