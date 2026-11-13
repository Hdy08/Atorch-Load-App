import { useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { Bluetooth20Regular } from "@fluentui/react-icons";
import { api } from "../lib/api";
import type { BleAction, BleCommandResult } from "../lib/types";

const clears = [
  [
    "clearEnergy",
    "清零设备电量",
    "将发送电量清零操作。BW150 按当前测试页面决定清除哪组电量累计；请先保存需要的数据。",
  ],
  [
    "clearCapacity",
    "清零设备容量",
    "将发送容量清零操作。BW150 按当前测试页面决定清除哪组容量累计；请先保存需要的数据。",
  ],
  [
    "clearTime",
    "清零设备计时",
    "将发送设备计时清零操作，当前设备计时可能无法恢复。这不会重置本应用的连接时长或删除本机记录。",
  ],
] as const;

/** The remote panel mirrors physical keys; it cannot read back their UI context. */
export function BleControls({
  connected,
  busy,
  onTask,
}: {
  connected: boolean;
  busy: boolean;
  onTask: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<{
    action: BleAction;
    title: string;
    text: string;
    clears: boolean;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<BleCommandResult | null>(null);
  const disabled = !connected || busy;
  const send = (action: BleAction) =>
    onTask(async () => {
      setResult(null);
      setResult(await api.bleCommand(action));
    });
  return (
    <div className="ble-controls">
      <div className="section-head">
        <h2>蓝牙面板遥控</h2>
        <Bluetooth20Regular />
      </div>
      <div className="ble-panel-state">
        <Badge appearance="tint" color="informative">
          设备状态未知
        </Badge>
        <span>请同时查看 BW150 屏幕</span>
      </div>
      <p className="muted">
        按键作用与设备面板一致，取决于当前页面。加减可能改变目标值；确认键可能启停负载或提交当前选项。
      </p>
      <div className="ble-keys">
        <Button disabled={disabled} onClick={() => void send("keySet")}>
          设置 SET
        </Button>
        <Button disabled={disabled} onClick={() => void send("keyMinus")}>
          减 −
        </Button>
        <Button disabled={disabled} onClick={() => void send("keyPlus")}>
          加 +
        </Button>
        <Button
          appearance="primary"
          disabled={disabled}
          onClick={() => {
            setAcknowledged(false);
            setConfirmation({
              action: "keyOk",
              title: "发送确认键",
              text: "将向 BW150 发送一次 OK。设备可能启动或停止负载，也可能确认当前菜单或阶段选项。请先核对设备屏幕、接线及输入条件。",
              clears: false,
            });
          }}
        >
          确认 OK…
        </Button>
      </div>
      <div className="control-divider" />
      <div className="ble-clear-actions">
        {clears.map(([action, title, text]) => (
          <Button
            key={action}
            disabled={disabled}
            onClick={() => {
              setAcknowledged(false);
              setConfirmation({ action, title, text, clears: true });
            }}
          >
            {title}…
          </Button>
        ))}
      </div>
      <p className="muted">
        这些操作写入设备。设备仅回传监测数据，未回传模式、目标值或按键执行结果；收到数据不代表操作已执行。
      </p>
      {result && (
        <MessageBar intent="info">
          <MessageBarBody>{result.message}</MessageBarBody>
        </MessageBar>
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(_, data) => {
          if (!data.open && !busy) setConfirmation(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogContent>
              <p>{confirmation?.text}</p>
              <p>每次只发送一次，执行结果请以 BW150 屏幕为准。</p>
              {confirmation?.clears && (
                <Checkbox
                  label="我已保存所需数据，确认清零设备累计值"
                  checked={acknowledged}
                  onChange={(_, data) => setAcknowledged(data.checked === true)}
                />
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setConfirmation(null)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={disabled || (!!confirmation?.clears && !acknowledged)}
                onClick={() => {
                  if (!confirmation) return;
                  const action = confirmation.action;
                  setConfirmation(null);
                  void send(action);
                }}
              >
                {confirmation?.clears ? "确认清零并发送" : "发送一次 OK"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
