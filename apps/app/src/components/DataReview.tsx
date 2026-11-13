import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type Theme,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import type { Telemetry } from "../lib/types";
import {
  measurements,
  measurementKeys,
  summarize,
  type ChartBounds,
  type MeasurementKey,
} from "../lib/analysis";
import { TrendChart, type ChartTimeRange } from "./TrendChart";
import { MeasurementSelector } from "./MeasurementSelector";
import { ChartTimeSelect } from "./ChartTimeSelect";
import { sampleElapsedMs, type ChartTimeMode } from "../lib/chartTime";
import { samplesInChartRange } from "../lib/chartInteraction";
import { completeRecordCounters } from "../lib/records";
import { chartRangeSummary } from "../lib/chartData";

const pageSizes = [10, 20, 50, 100];
const pageSizeStorageKey = "atorch-review-page-size";

function readPageSize() {
  try {
    const value = Number(localStorage.getItem(pageSizeStorageKey));
    if (pageSizes.includes(value)) return value;
  } catch {
    // Use the default when storage is unavailable.
  }
  return 10;
}

const format = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: 3,
        useGrouping: false,
      });

export function DataReview({
  rows: sourceRows,
  title,
  theme,
  bounds,
  busy,
  onImage,
  onExport,
  timeMode,
  onTimeModeChange,
  selected,
  onSelectionChange,
}: {
  rows: Telemetry[];
  title: string;
  theme: Theme;
  bounds: ChartBounds;
  busy: boolean;
  onImage: (url: string) => void;
  onExport: (rows: Telemetry[]) => void;
  timeMode: ChartTimeMode;
  onTimeModeChange: (mode: ChartTimeMode) => void;
  selected: MeasurementKey[];
  onSelectionChange: (selected: MeasurementKey[]) => void;
}) {
  const rows = useMemo(() => completeRecordCounters(sourceRows), [sourceRows]);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [page, setPage] = useState(0);
  const [pageText, setPageText] = useState("1");
  const [chartRange, setChartRange] = useState<ChartTimeRange>();
  const available = useMemo(
    () =>
      (Object.keys(measurements) as MeasurementKey[]).filter((key) =>
        rows.length === 0
          ? ["voltage", "current", "power"].includes(key)
          : summarize(rows, key).count > 0,
      ),
    [rows],
  );
  const keys = selected;
  const origin = rows[0]?.timestamp ?? 0;
  const exportRows = useMemo(
    () => samplesInChartRange(rows, chartRange, timeMode === "elapsed", origin),
    [rows, chartRange, timeMode, origin],
  );
  const stats = useMemo(
    () =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          chartRangeSummary(rows, key, chartRange, timeMode === "elapsed"),
        ]),
      ),
    [rows, chartRange, timeMode, keys],
  );
  const calculated = useMemo(
    () => ({
      energy: exportRows.some((row) => row.energyCalculated),
      capacity: exportRows.some((row) => row.capacityCalculated),
    }),
    [exportRows],
  );
  const pages = Math.max(1, Math.ceil(exportRows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    setPage(currentPage);
    setPageText(String(currentPage + 1));
  }, [currentPage]);
  useEffect(() => {
    try {
      localStorage.setItem(pageSizeStorageKey, String(pageSize));
    } catch {
      // Pagination still works when storage is unavailable.
    }
  }, [pageSize]);
  const jumpPage = () => {
    const value = Number(pageText);
    const next = Number.isInteger(value)
      ? Math.max(1, Math.min(pages, value))
      : currentPage + 1;
    setPage(next - 1);
    setPageText(String(next));
  };
  const detailRows = exportRows
    .slice(
      Math.max(0, exportRows.length - (currentPage + 1) * pageSize),
      exportRows.length - currentPage * pageSize,
    )
    .reverse();
  const rangeLabel = exportRows.length
    ? `${new Date(exportRows[0].timestamp).toLocaleString()} — ${new Date(exportRows.at(-1)!.timestamp).toLocaleString()}`
    : "暂无可显示的数据";

  return (
    <>
      <Card className="review-card">
        <div className="section-head review-heading">
          <div>
            <h2>{title}</h2>
            <span>
              {exportRows.length.toLocaleString()} /{" "}
              {rows.length.toLocaleString()} 个采样点 · {rangeLabel}
            </span>
          </div>
          <div className="chart-toolbar">
            <ChartTimeSelect
              value={timeMode}
              onChange={(mode) => {
                setChartRange(undefined);
                onTimeModeChange(mode);
              }}
            />
          </div>
        </div>
        <MeasurementSelector
          selected={keys}
          onChange={onSelectionChange}
          bounds={bounds}
          theme={theme}
        />
        <TrendChart
          key={timeMode}
          samples={rows}
          elapsed={
            timeMode === "elapsed"
              ? {
                  origin,
                  current: rows.length
                    ? sampleElapsedMs(rows.at(-1)!, origin)
                    : 0,
                  fromZero: true,
                }
              : undefined
          }
          selected={keys}
          bounds={bounds}
          theme={theme}
          onImage={onImage}
          imageBusy={busy}
          onRangeChange={setChartRange}
          exportAction={(visible, getCurrentRows) => (
            <Button
              icon={<ArrowDownload20Regular />}
              disabled={busy || !visible.length}
              onClick={() => onExport(getCurrentRows())}
            >
              导出 CSV
            </Button>
          )}
        />
      </Card>
      <Card className="table-card">
        <div className="section-head">
          <h2>采样统计</h2>
        </div>
        <div className="table-scroll">
          <Table className="sample-table" aria-label="采样统计">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>通道</TableHeaderCell>
                <TableHeaderCell>有效点数</TableHeaderCell>
                <TableHeaderCell>最小值</TableHeaderCell>
                <TableHeaderCell>最大值</TableHeaderCell>
                <TableHeaderCell>平均值</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {measurementKeys
                .filter((key) => keys.includes(key))
                .map((key) => (
                  <TableRow key={key}>
                    <TableCell>
                      {measurements[key].name} / {measurements[key].unit}
                      {((key === "energy" && calculated.energy) ||
                        (key === "capacity" && calculated.capacity)) &&
                        " (计算)"}
                    </TableCell>
                    <TableCell>{stats[key]?.count ?? 0}</TableCell>
                    <TableCell>{format(stats[key]?.min)}</TableCell>
                    <TableCell>{format(stats[key]?.max)}</TableCell>
                    <TableCell>{format(stats[key]?.average)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      <Card className="table-card">
        <div className="section-head details-heading">
          <h2>采样明细</h2>
          <div className="review-page-controls">
            <Select
              aria-label="每页条数"
              value={String(pageSize)}
              onChange={(_, data) => {
                setPageSize(Number(data.value));
                setPage(0);
                setPageText("1");
              }}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  每页 {size} 条
                </option>
              ))}
            </Select>
            <Input
              aria-label="跳转页码"
              type="number"
              inputMode="numeric"
              min={1}
              max={pages}
              step={1}
              value={pageText}
              onChange={(_, data) => setPageText(data.value)}
              onBlur={jumpPage}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jumpPage();
                }
              }}
            />
          </div>
        </div>
        <div className="table-scroll">
          <Table className="sample-table" aria-label="采样明细">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>时间</TableHeaderCell>
                {available.map((key) => (
                  <TableHeaderCell key={key}>
                    {measurements[key].name} / {measurements[key].unit}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detailRows.map((row, index) => (
                <TableRow key={`${row.timestamp}-${index}`}>
                  <TableCell>
                    {new Date(row.timestamp).toLocaleString()}
                  </TableCell>
                  {available.map((key) => (
                    <TableCell className="mono" key={key}>
                      {format(row[key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!exportRows.length && (
          <div className="table-empty">
            {rows.length
              ? "该时间范围内没有采样点"
              : "导入 CSV、打开本机记录，或连接设备开始采集"}
          </div>
        )}
        <div className="review-pagination">
          <Button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <span>
            第 {currentPage + 1} / {pages} 页
          </span>
          <Button
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </div>
      </Card>
    </>
  );
}
