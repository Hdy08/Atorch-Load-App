import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  ColorSwatch,
  Field,
  Input,
  Select,
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
              notify({ text: "界面缩放范围为 50%–200%", error: true });
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
            <h2>外观</h2>
            <Field label="主题">
              <Select
                aria-label="主题"
                value={draft.theme}
                onChange={(_, data) =>
                  setDraft({
                    ...draft,
                    theme: data.value as Appearance["theme"],
                  })
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </Select>
            </Field>
            <Field label="界面缩放">
              <div className="appearance-scale">
                <Slider
                  aria-label="界面缩放滑动条"
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
                <Input
                  aria-label="界面缩放"
                  type="number"
                  min={50}
                  max={200}
                  step={1}
                  value={scaleText}
                  contentAfter="%"
                  onChange={(_, data) => setScaleText(data.value)}
                />
              </div>
            </Field>
            <Field label="侧栏">
              <Select
                aria-label="侧栏"
                value={draft.sidebar}
                onChange={(_, data) =>
                  setDraft({
                    ...draft,
                    sidebar: data.value as Appearance["sidebar"],
                  })
                }
              >
                <option value="auto">自动</option>
                <option value="expanded">始终展开</option>
                <option value="collapsed">始终收起</option>
              </Select>
            </Field>
            <Field label="页面过渡动画">
              <Select
                aria-label="页面过渡动画"
                value={draft.transition}
                onChange={(_, data) =>
                  setDraft({
                    ...draft,
                    transition: data.value as Appearance["transition"],
                  })
                }
              >
                <option value="slide">平移</option>
                <option value="fade">淡入</option>
                <option value="scale">缩放</option>
                <option value="none">无</option>
              </Select>
            </Field>
          </Card>
          <Card>
            <h2>强调色</h2>
            <Field label="强调色来源">
              <Select
                aria-label="强调色来源"
                value={draft.accent}
                onChange={(_, data) =>
                  setDraft({
                    ...draft,
                    accent: data.value as Appearance["accent"],
                  })
                }
              >
                <option value="system">跟随系统</option>
                <option value="custom">自定义</option>
              </Select>
            </Field>
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
            <Field label="颜色">
              <Input
                aria-label="强调色"
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
            </Field>
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
            <h2>连接</h2>
            <Field label="自动连接">
              <Select
                aria-label="自动连接"
                disabled={busy}
                value={connectionDraft}
                onChange={(_, data) =>
                  setConnectionDraft(data.value as AutoConnectPreference)
                }
              >
                <option value="off">关</option>
                <option value="prefer-usb">优先 USB</option>
                <option value="prefer-ble">优先 BLE</option>
                <option value="usb-only">仅 USB</option>
                <option value="ble-only">仅 BLE</option>
              </Select>
            </Field>
          </Card>
        </form>
      </section>
    </>
  );
}
