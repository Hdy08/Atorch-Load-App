import { NumericInput } from "./NumericInput";
import { useEffect, useState } from "react";
import { Card, Switch } from "@fluentui/react-components";
import { MenuSelect } from "./MenuSelect";
import {
  defaultAutoRecording,
  type AutoRecordingSettings,
  type RecordingParameter,
  type RecordingComparison,
} from "../lib/autoRecording";
import { useNotify } from "./Notifications";

const parameters = {
  voltage: { name: "电压", unit: "V" },
  current: { name: "电流", unit: "A" },
  power: { name: "功率", unit: "W" },
};
function asDraft(value: AutoRecordingSettings) {
  return {
    mode: value.mode,
    startOnLoad: {
      ...value.startOnLoad,
      delaySeconds: value.startOnLoad.delaySeconds.toFixed(1),
    },
    stopOnLoad: {
      ...value.stopOnLoad,
      delaySeconds: value.stopOnLoad.delaySeconds.toFixed(1),
    },
    startThreshold: {
      ...value.startThreshold,
      value: String(value.startThreshold.value),
      holdSeconds: value.startThreshold.holdSeconds.toFixed(1),
    },
    stopThreshold: {
      ...value.stopThreshold,
      value: String(value.stopThreshold.value),
      holdSeconds: value.stopThreshold.holdSeconds.toFixed(1),
    },
  };
}

function timeText(text: string) {
  const value = Number(text);
  return text.trim() &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.abs(value * 10 - Math.round(value * 10)) <= 1e-7
    ? value.toFixed(1)
    : text;
}

export function AutoRecordingForm({
  id,
  value,
  disabled,
  onApply,
}: {
  id: string;
  value: AutoRecordingSettings;
  disabled: boolean;
  onApply: (settings: AutoRecordingSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => asDraft(value));
  const notify = useNotify();
  // Equal settings in polling snapshots must not replace unsaved edits.
  const saved = JSON.stringify(value);
  useEffect(() => setDraft(asDraft(JSON.parse(saved))), [saved]);
  const number = (
    text: string,
    label: string,
    active: boolean,
    nonnegative = true,
  ) => {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || (nonnegative && value < 0)) {
      if (active)
        throw Error(
          `${label}${nonnegative ? "必须为非负的有效秒数" : "请输入有效数值"}`,
        );
      return 0;
    }
    if (nonnegative && Math.abs(Math.round(value * 10) - value * 10) > 1e-7) {
      if (active) throw Error(`${label}最多保留一位小数`);
      return 0;
    }
    return value;
  };
  return (
    <form
      id={id}
      noValidate
      onReset={(event) => {
        event.preventDefault();
        setDraft(asDraft(defaultAutoRecording()));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        try {
          const device = (
            key: "startOnLoad" | "stopOnLoad",
            label: string,
          ) => ({
            ...draft[key],
            delaySeconds: number(
              draft[key].delaySeconds,
              label,
              draft.mode === "device" && draft[key].enabled,
            ),
          });
          const threshold = (
            key: "startThreshold" | "stopThreshold",
            label: string,
          ) => ({
            ...draft[key],
            value: number(
              draft[key].value,
              `${label}阈值`,
              draft.mode === "threshold" && draft[key].enabled,
              false,
            ),
            holdSeconds: number(
              draft[key].holdSeconds,
              `${label}保持时间`,
              draft.mode === "threshold" && draft[key].enabled,
            ),
          });
          void onApply({
            mode: draft.mode,
            startOnLoad: device("startOnLoad", "启动延迟"),
            stopOnLoad: device("stopOnLoad", "关闭延迟"),
            startThreshold: threshold("startThreshold", "开始"),
            stopThreshold: threshold("stopThreshold", "停止"),
          });
        } catch (error) {
          notify({
            text: error instanceof Error ? error.message : String(error),
            error: true,
          });
        }
      }}
    >
      <Card className="auto-recording-card">
        <h2>自动记录</h2>
        <MenuSelect
          className="auto-recording-mode"
          aria-label="自动记录"
          value={draft.mode}
          disabled={disabled}
          onChange={(value) =>
            setDraft({
              ...draft,
              mode: value as AutoRecordingSettings["mode"],
            })
          }
          options={[
            { value: "off", label: "关" },
            { value: "device", label: "跟随设备" },
            { value: "threshold", label: "设置阈值" },
          ]}
        />
        {draft.mode === "device" && (
          <div className="auto-recording-rules">
            {(
              [
                ["startOnLoad", "启动时开始", "启动延迟"],
                ["stopOnLoad", "关闭时停止", "关闭延迟"],
              ] as const
            ).map(([key, label, name]) => (
              <div className="auto-recording-rule" key={key}>
                <Switch
                  label={label}
                  checked={draft[key].enabled}
                  disabled={disabled}
                  onChange={(_, data) =>
                    setDraft({
                      ...draft,
                      [key]: { ...draft[key], enabled: data.checked },
                    })
                  }
                />
                <label className="record-rule-time">
                  <span>延迟</span>
                  <NumericInput
                    aria-label={name}

                    min={0}
                    step={0.1}
                    precision={1}
                    unit="s"
                    value={draft[key].delaySeconds}
                    onBlur={(event) => {
                      const text = timeText(event.target.value);
                      setDraft((previous) => ({
                        ...previous,
                        [key]: { ...previous[key], delaySeconds: text },
                      }));
                    }}
                    disabled={disabled || !draft[key].enabled}
                    onChange={(_, data) =>
                      setDraft({
                        ...draft,
                        [key]: { ...draft[key], delaySeconds: data.value },
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </div>
        )}
        {draft.mode === "threshold" && (
          <div className="auto-recording-rules">
            {(
              [
                ["startThreshold", "开始"],
                ["stopThreshold", "停止"],
              ] as const
            ).map(([key, label]) => (
              <div className="auto-recording-rule" key={key}>
                <Switch
                  label={`${label}阈值`}
                  checked={draft[key].enabled}
                  disabled={disabled}
                  onChange={(_, data) =>
                    setDraft({
                      ...draft,
                      [key]: { ...draft[key], enabled: data.checked },
                    })
                  }
                />
                <div className="record-rule-condition">
                  <MenuSelect
                    aria-label={`${label}参数`}
                    value={draft[key].parameter}
                    disabled={disabled || !draft[key].enabled}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        [key]: {
                          ...draft[key],
                          parameter: value as RecordingParameter,
                        },
                      })
                    }
                    options={Object.entries(parameters).map(
                      ([value, { name }]) => ({ value, label: name }),
                    )}
                  />
                  <MenuSelect
                    aria-label={`${label}条件`}
                    value={draft[key].comparison}
                    disabled={disabled || !draft[key].enabled}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        [key]: {
                          ...draft[key],
                          comparison: value as RecordingComparison,
                        },
                      })
                    }
                    options={[
                      { value: "less", label: "小于" },
                      { value: "greater", label: "大于" },
                    ]}
                  />
                  <NumericInput
                    className="record-threshold-value"
                    aria-label={`${label}阈值`}

                    step={0.001}
                    unit={parameters[draft[key].parameter].unit}
                    value={draft[key].value}
                    disabled={disabled || !draft[key].enabled}
                    onChange={(_, data) =>
                      setDraft({
                        ...draft,
                        [key]: { ...draft[key], value: data.value },
                      })
                    }
                  />
                  <label className="record-rule-time">
                    <span>保持</span>
                    <NumericInput
                      aria-label={`${label}保持时间`}

                      min={0}
                      step={0.1}
                      precision={1}
                      unit="s"
                      value={draft[key].holdSeconds}
                      onBlur={(event) => {
                        const text = timeText(event.target.value);
                        setDraft((previous) => ({
                          ...previous,
                          [key]: { ...previous[key], holdSeconds: text },
                        }));
                      }}
                      disabled={disabled || !draft[key].enabled}
                      onChange={(_, data) =>
                        setDraft({
                          ...draft,
                          [key]: { ...draft[key], holdSeconds: data.value },
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </form>
  );
}
