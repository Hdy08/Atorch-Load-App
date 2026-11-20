import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  ColorSwatch,
  Field,
  Input,
  Slider,
  SwatchPicker,
  Tab,
  TabList,
  type Theme,
} from "@fluentui/react-components";
import { Eyedropper20Regular } from "@fluentui/react-icons";
import { defaultAppearance, type Appearance } from "../lib/appearance";
import type { AutoConnectPreference } from "../lib/autoConnect";
import { measurementKeys, type ChartBounds } from "../lib/analysis";
import { ChartScaleSettings } from "./ChartScaleSettings";
import { useNotify } from "./Notifications";
import { AutoRecordingForm } from "./AutoRecordingForm";
import type { AutoRecordingSettings } from "../lib/autoRecording";
import { MenuSelect } from "./MenuSelect";
import { NumericInput } from "./NumericInput";

export type ApplicationTab =
  "appearance" | "curves" | "recording" | "connection";
export const settingsForm = (tab: string) => `application-settings-${tab}`;
const presets = [
  "#0f6cbd",
  "#0078d4",
  "#009688",
  "#107c10",
  "#8764b8",
  "#c239b3",
  "#d13438",
  "#da3b01",
  "#986f0b",
  "#69797e",
];

export function ApplicationSettings({
  tab,
  onTabChange,
  appearance,
  onAppearanceChange,
  systemAccent,
  theme,
  chartBounds,
  onChartChange,
  recording,
  onRecordingChange,
  recordingDisabled,
  connection,
  onConnectionChange,
  busy,
}: {
  tab: ApplicationTab;
  onTabChange: (tab: ApplicationTab) => void;
  appearance: Appearance;
  onAppearanceChange: (value: Appearance) => void;
  systemAccent: string;
  theme: Theme;
  chartBounds: ChartBounds;
  onChartChange: (value: ChartBounds) => void;
  recording: AutoRecordingSettings;
  onRecordingChange: (value: AutoRecordingSettings) => Promise<void>;
  recordingDisabled: boolean;
  connection: AutoConnectPreference;
  onConnectionChange: (value: AutoConnectPreference) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(appearance);
  const [scaleText, setScaleText] = useState(String(appearance.scale));
  const [connectionDraft, setConnectionDraft] = useState(connection);
  const picker = useRef<HTMLInputElement>(null);
  const notify = useNotify();
  useEffect(() => {
    setDraft(appearance);
    setScaleText(String(appearance.scale));
  }, [appearance]);
  useEffect(() => setConnectionDraft(connection), [connection]);
  const saved = () => notify({ text: "已保存", error: false });
  return (
    <>
      <TabList
        aria-label="应用设置分类"
        selectedValue={tab}
        onTabSelect={(_, data) => onTabChange(data.value as ApplicationTab)}
      >
        {(
          [
            ["appearance", "外观"],
            ["curves", "曲线"],
            ["recording", "记录"],
            ["connection", "连接"],
          ] as const
        ).map(([id, name]) => (
          <Tab
            key={id}
            id={`application-tab-${id}`}
            value={id}
            aria-controls={`application-panel-${id}`}
          >
            {name}
          </Tab>
        ))}
      </TabList>
      <section
        id="application-panel-appearance"
        hidden={tab !== "appearance"}
        role="tabpanel"
        aria-labelledby="application-tab-appearance"
      >
        <form
          id={settingsForm("appearance")}
          className="appearance-settings"
          noValidate
          onReset={(event) => {
            event.preventDefault();
            setDraft({ ...defaultAppearance });
            setScaleText(String(defaultAppearance.scale));
          }}
          onSubmit={(event) => {
            event.preventDefault();
            const scale = Number(scaleText);
            if (
              !scaleText.trim() ||
              !Number.isFinite(scale) ||
              scale < 50 ||
              scale > 200
            ) {
              notify({ text: "缩放范围为 50%–200%", error: true });
              return;
            }
            if (!/^#[0-9a-f]{6}$/i.test(draft.accentColor)) {
              notify({ text: "请输入有效的强调色（#RRGGBB）", error: true });
              return;
            }
            onAppearanceChange({ ...draft, scale });
            saved();
          }}
        >
          <Card>
            <h2>界面</h2>
            <Field label="主题">
              <MenuSelect
                aria-label="主题"
                value={draft.theme}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    theme: value as Appearance["theme"],
                  })
                }
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
              />
            </Field>
            <Field label="缩放">
              <div className="appearance-scale">
                <Slider
                  aria-label="缩放滑动条"
                  min={50}
                  max={200}
                  input={{ step: 1 }}
                  value={
                    Number.isFinite(Number(scaleText))
                      ? Math.min(200, Math.max(50, Number(scaleText)))
                      : 100
                  }
                  onChange={(_, data) => setScaleText(String(data.value))}
                />
                <NumericInput
                  aria-label="缩放"
                  min={50}
                  max={200}
                  step={1}
                  value={scaleText}
                  unit="%"
                  precision={0}
                  onChange={(_, data) => setScaleText(data.value)}
                />
              </div>
            </Field>
            <Field label="侧栏">
              <MenuSelect
                aria-label="侧栏"
                value={draft.sidebar}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    sidebar: value as Appearance["sidebar"],
                  })
                }
                options={[
                  { value: "auto", label: "自动" },
                  { value: "expanded", label: "始终展开" },
                  { value: "collapsed", label: "始终收起" },
                ]}
              />
            </Field>
            <Field label="页面过渡动画">
              <MenuSelect
                aria-label="页面过渡动画"
                value={draft.transition}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    transition: value as Appearance["transition"],
                  })
                }
                options={[
                  { value: "slide", label: "平移" },
                  { value: "fade", label: "淡入" },
                  { value: "scale", label: "缩放" },
                  { value: "none", label: "无" },
                ]}
              />
            </Field>
          </Card>
          <Card>
            <h2>强调色</h2>
            <MenuSelect
              aria-label="强调色来源"
              value={draft.accent}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  accent: value as Appearance["accent"],
                })
              }
              options={[
                { value: "system", label: "跟随系统" },
                { value: "custom", label: "自定义" },
              ]}
            />
            <SwatchPicker
              aria-label="强调色预设"
              selectedValue={
                draft.accent === "system" ? systemAccent : draft.accentColor
              }
              onSelectionChange={(_, data) =>
                setDraft({
                  ...draft,
                  accent: "custom",
                  accentColor: data.selectedValue,
                })
              }
            >
              {presets.map((color) => (
                <ColorSwatch
                  key={color}
                  value={color}
                  color={color}
                  aria-label={`强调色 ${color}`}
                />
              ))}
            </SwatchPicker>
            <Input
              aria-label="强调色"
              className="accent-color-input"
              value={
                draft.accent === "system" ? systemAccent : draft.accentColor
              }
              maxLength={7}
              onChange={(_, data) =>
                setDraft({
                  ...draft,
                  accent: "custom",
                  accentColor: data.value,
                })
              }
              contentAfter={
                <Button
                  type="button"
                  appearance="subtle"
                  size="small"
                  aria-label="强调色取色器"
                  icon={<Eyedropper20Regular />}
                  onClick={() => picker.current?.click()}
                />
              }
            />
            <input
              ref={picker}
              className="axis-native-color"
              type="color"
              aria-label="强调色取色值"
              tabIndex={-1}
              value={
                draft.accent === "system"
                  ? systemAccent
                  : /^#[0-9a-f]{6}$/i.test(draft.accentColor)
                    ? draft.accentColor
                    : systemAccent
              }
              onChange={(event) =>
                setDraft({
                  ...draft,
                  accent: "custom",
                  accentColor: event.target.value,
                })
              }
            />
          </Card>
        </form>
      </section>
      <section
        id="application-panel-curves"
        hidden={tab !== "curves"}
        role="tabpanel"
        aria-labelledby="application-tab-curves"
      >
        <ChartScaleSettings
          formId={settingsForm("curves")}
          externalActions
          selected={measurementKeys}
          bounds={chartBounds}
          theme={theme}
          onChange={(next) => {
            onChartChange(next);
            saved();
          }}
        />
      </section>
      <section
        id="application-panel-recording"
        hidden={tab !== "recording"}
        role="tabpanel"
        aria-labelledby="application-tab-recording"
      >
        <AutoRecordingForm
          id={settingsForm("recording")}
          value={recording}
          disabled={recordingDisabled}
          onApply={onRecordingChange}
        />
      </section>
      <section
        id="application-panel-connection"
        hidden={tab !== "connection"}
        role="tabpanel"
        aria-labelledby="application-tab-connection"
      >
        <form
          id={settingsForm("connection")}
          onReset={(event) => {
            event.preventDefault();
            setConnectionDraft("prefer-usb");
          }}
          onSubmit={(event) => {
            event.preventDefault();
            onConnectionChange(connectionDraft);
            saved();
          }}
        >
          <Card>
            <h2>自动连接</h2>
            <MenuSelect
              aria-label="自动连接"
              disabled={busy}
              value={connectionDraft}
              onChange={(value) =>
                setConnectionDraft(value as AutoConnectPreference)
              }
              options={[
                { value: "prefer-usb", label: "优先 USB" },
                { value: "prefer-ble", label: "优先 BLE" },
                { value: "usb-only", label: "仅 USB" },
                { value: "ble-only", label: "仅 BLE" },
                { value: "off", label: "关" },
              ]}
            />
          </Card>
        </form>
      </section>
    </>
  );
}
