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
} from "@fluentui/react-components";
import { Bluetooth20Regular } from "@fluentui/react-icons";
import { api } from "../lib/api";
import type { BleAction } from "../lib/types";

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
  onNotice,
}: {
  connected: boolean;
  busy: boolean;
  onTask: (task: () => Promise<unknown>) => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const [confirmation, setConfirmation] = useState<{
    action: BleAction;
    title: string;
    text: string;
    clears: boolean;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const disabled = !connected || busy;
  const send = (action: BleAction) =>
    onTask(async () => {
      const result = await api.bleCommand(action);
      onNotice(result.message);
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
