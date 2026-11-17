import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { api } from "../lib/api";
import { Notification } from "./Notifications";
import {
  modes,
  type PromptContext,
  type Snapshot,
  type StageAction,
} from "../lib/types";

const number = (v: number | null | undefined, digits = 3) =>
  v == null ? "—" : v.toFixed(digits);
const date = (v: number | null | undefined) =>
  v == null
    ? "未观察到开始"
    : new Date(v).toLocaleString("zh-CN", { hour12: false });

export function SpecialTests({
  snapshot,
  busy,
  onCommand,
  onTask,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onCommand: (
    kind: string,
    value: number,
    expectedMode?: number,
    expectedPrompt?: PromptContext,
  ) => Promise<void>;
  onTask: (task: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<{
    action: StageAction;
    context: PromptContext;
    mode: number;
  } | null>(null);
  const settings = snapshot.settings;
  const mode = settings?.mode;
  const active =
    snapshot.specialTest?.reading.mode === mode ? snapshot.specialTest : null;
  const reading = active?.reading;
  const prompt = reading?.prompt;
  const results = snapshot.specialResults ?? [];
  const enabled =
    snapshot.connected &&
    snapshot.device?.transport !== "bluetooth" &&
    !busy &&
    !!reading &&
    Date.now() - reading.timestamp < 2500;
  if ((mode == null || mode < 4) && !results.length) return null;
  const exportResults = async () => {
    const header =
      "MODE,START_MS,STOP_MS,OBSERVED_START,PEAK_POWER(W),PEAK_CURRENT(A),LAST_RUNNING_VOLTAGE(V),LAST_RUNNING_CURRENT(A),LAST_RUNNING_POWER(W),LAST_RUNNING_RESISTANCE(Ω),STOP_VOLTAGE(V),STOP_CURRENT(A),STOP_POWER(W),STOP_RESISTANCE(Ω),STOP_ENERGY(Wh),STOP_CAPACITY(mAh),STOP_STATUS,STOP_PROMPT";
    const content =
      "\uFEFF" +
      [
        header,
        ...results.map((r) =>
          [
            modes[r.mode]?.[0] ?? r.mode,
            r.startedAt ?? "",
            r.stoppedAt,
            r.observedStart,
            r.peakPower ?? "",
            r.peakCurrent ?? "",
            r.lastRunning.voltage,
            r.lastRunning.current,
            r.lastRunning.power,
            r.lastRunning.resistance ?? "",
            r.stopped.voltage,
            r.stopped.current,
            r.stopped.power,
            r.stopped.resistance ?? "",
            r.stopped.energy ?? "",
            r.stopped.capacity,
            r.stopped.status,
            r.stopped.stageCode ?? "",
          ].join(","),
        ),
      ].join("\n") +
      "\n";
    const path = await api.saveCsv(`BW150_special_${Date.now()}.csv`, content);
    return path;
  };
  return (
    <Card className="special-tests" data-testid="special-test">
      <div className="section-head">
        <h2>专用测试与阶段控制</h2>
        <Badge appearance="tint">{mode == null ? "—" : modes[mode]?.[0]}</Badge>
      </div>
      {mode != null && mode >= 4 && (
        <>
          <p className="muted">
            读数来自设备 USB
            报文。停止时读数与运行中最后读数分别保留；停止原因和合格判定尚未解析。
          </p>
          <div className="special-values">
            <div>
              <span>
                {mode === 4
                  ? "内阻通道读数"
                  : mode === 6
                    ? "线阻通道读数"
                    : "电阻通道读数"}
              </span>
              <strong>{number(reading?.resistance)} Ω</strong>
            </div>
            <div>
              <span>实时功率</span>
              <strong>{number(reading?.power)} W</strong>
            </div>
            <div>
              <span>本次采集峰值功率</span>
              <strong>{number(active?.peakPower)} W</strong>
            </div>
            <div>
              <span>设备状态码 / 提示码</span>
              <strong>
                {reading
                  ? `${reading.status} / ${reading.stageCode ?? "—"}`
                  : "—"}
              </strong>
            </div>
          </div>
          {(mode === 7 || mode === 8) && (
            <p>
              循环设置：放电 {number(settings?.target)} A · 截止{" "}
              {number(settings?.cutoffVoltage)} V · 充满{" "}
              {number(settings?.fullVoltage)} V · 充电截止{" "}
              {number(settings?.cutoffCurrent)}{" "}
              A。请在“设备设置”核对电池参数，设备负责自动推进充放电流程。
            </p>
          )}
          {mode === 9 && (
            <Notification
              intent="info"
              text="CDxn 可读取专用状态与记录结果；循环次数和阶段动作尚未核准，请在设备面板启动。"
            />
          )}
          {prompt ? (
            <div className="stage-prompt" data-testid="stage-prompt">
              <strong>设备等待阶段选择</strong>
              <p>
                提示类型 {prompt.kind} · 当前选项 {prompt.selection} · 状态码{" "}
                {prompt.context.status}
              </p>
              {!prompt.actions.length && (
                <p>暂未核准此提示的操作，请在设备面板处理。</p>
              )}
              <div className="stage-actions">
                {prompt.actions.map((action) => (
                  <Button
                    key={action.value}
                    disabled={!enabled}
                    onClick={() =>
                      setConfirmation({
                        action,
                        context: prompt.context,
                        mode: mode!,
                      })
                    }
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">
              {reading?.running
                ? "设备正在测试；阶段提示出现时可在这里选择。"
                : "当前没有待处理的阶段提示。"}
            </p>
          )}
        </>
      )}
      <div className="section-head">
        <h3>专用测试停止记录（本次连接）</h3>
        <Button
          disabled={!results.length || busy}
          onClick={() => void onTask(exportResults, "专用测试结果 CSV 已保存")}
        >
          导出结果 CSV
        </Button>
      </div>
      {results.length ? (
        <div className="special-result-list">
          {results
            .slice()
            .reverse()
            .map((r, i) => (
              <div
                className="special-result"
                key={`${r.mode}:${r.stoppedAt}:${i}`}
              >
                <strong>{modes[r.mode]?.[0]} · 设备已停止</strong>
                <span>
                  开始：{date(r.startedAt)} · 停止：{date(r.stoppedAt)}
                </span>
                <span>
                  运行中最后读数：{number(r.lastRunning.voltage)} V /{" "}
                  {number(r.lastRunning.current)} A /{" "}
                  {number(r.lastRunning.power)} W /{" "}
                  {number(r.lastRunning.resistance)} Ω
                </span>
                <span>
                  停止时设备读数：{number(r.stopped.resistance)} Ω ·{" "}
                  {number(r.stopped.energy)} Wh · {number(r.stopped.capacity)}{" "}
                  mAh
                </span>
                <span>
                  采集峰值：{number(r.peakPower)} W / {number(r.peakCurrent)} A
                  · 停止码 {r.stopped.status}（原因未解析）
                  {!r.observedStart ? " · 连接时已在运行，记录不完整" : ""}
                </span>
              </div>
            ))}
        </div>
      ) : (
        <p className="muted">
          观察到设备从运行变为停止后生成记录；切换模式或断线不视为测试完成。
        </p>
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setConfirmation(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{confirmation?.action.label}</DialogTitle>
            <DialogContent>
              <p>
                {confirmation?.action.clearsData
                  ? "设备将清除数据并启动新一轮放电。请确认接线与电池的充满、放完电压设置。"
                  : `将向设备发送“${confirmation?.action.label}”阶段动作。`}
              </p>
              <p>设备将重新校对当前模式和阶段提示，再执行操作。</p>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmation(null)}>取消</Button>
              <Button
                appearance="primary"
                disabled={busy || !enabled}
                onClick={() => {
                  const c = confirmation;
                  setConfirmation(null);
                  if (c)
                    void onCommand("stage", c.action.value, c.mode, c.context);
                }}
              >
                确认阶段操作
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Card>
  );
}
