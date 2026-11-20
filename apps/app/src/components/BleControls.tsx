import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { Bluetooth20Regular, Settings20Regular } from "@fluentui/react-icons";
import { api } from "../lib/api";
import type { BleAction } from "../lib/types";
import { useNotify } from "./Notifications";

const clears = [
  [
    "clearEnergy",
    "清空电量",
    "将发送电量清零操作。设备按当前测试页面决定清除哪组电量累计；请先保存需要的数据。",
  ],
  [
    "clearCapacity",
    "清空容量",
    "将发送容量清零操作。设备按当前测试页面决定清除哪组容量累计；请先保存需要的数据。",
  ],
  [
    "clearTime",
    "清空计时",
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
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    action: BleAction;
    title: string;
    text: string;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const disabled = !connected || busy;
  const send = (action: BleAction) =>
    onTask(async () => {
      const result = await api.bleCommand(action);
      notify({ text: result.message, error: false, intent: "info" });
    });
  return (
    <div className="ble-controls">
      <span className="mode-code" title="BLE 蓝牙控制">
        <Bluetooth20Regular />
      </span>
      <div className="ble-keys" aria-label="蓝牙面板遥控">
        <Button
          aria-label="SET"
          disabled={disabled}
          onClick={() => void send("keySet")}
        >
          SET
        </Button>
        <Button
          aria-label="-"
          disabled={disabled}
          onClick={() => void send("keyMinus")}
        >
          -
        </Button>
        <Button
          aria-label="+"
          disabled={disabled}
          onClick={() => void send("keyPlus")}
        >
          +
        </Button>
        <Button
          aria-label="OK"
          appearance="primary"
          disabled={disabled}
          onClick={() => void send("keyOk")}
        >
          OK
        </Button>
      </div>
      <Button
        appearance="subtle"
        icon={<Settings20Regular />}
        aria-label="蓝牙控制设置"
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
        <DialogSurface className="ble-control-dialog">
          <DialogBody>
            <DialogTitle>负载控制</DialogTitle>
            <DialogContent>
              <TabList selectedValue="bluetooth" aria-label="负载控制设置">
                <Tab
                  value="bluetooth"
                  id="load-tab-bluetooth"
                  aria-controls="load-panel-bluetooth"
                >
                  蓝牙控制
                </Tab>
              </TabList>
              <section
                role="tabpanel"
                id="load-panel-bluetooth"
                aria-labelledby="load-tab-bluetooth"
                className="ble-clear-actions"
              >
                {clears.map(([action, title, text]) => (
                  <Button
                    key={action}
                    disabled={disabled}
                    onClick={() => {
                      setAcknowledged(false);
                      setOpen(false);
                      setConfirmation({ action, title, text });
                    }}
                  >
                    {title}
                  </Button>
                ))}
              </section>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setOpen(false)}>关闭</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
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
              <p>每次只发送一次，执行结果请以设备屏幕为准。</p>
              <Checkbox
                label="我已保存所需数据，确认清零设备累计值"
                checked={acknowledged}
                onChange={(_, data) => setAcknowledged(data.checked === true)}
              />
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setConfirmation(null)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={disabled || !acknowledged}
                onClick={() => {
                  if (!confirmation) return;
                  const action = confirmation.action;
                  setConfirmation(null);
                  void send(action);
                }}
              >
                确认清零并发送
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
