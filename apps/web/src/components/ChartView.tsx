"use client";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Image as ImageIcon, Maximize2, X } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DataAnalysisDashboardSchema, type Deliverable } from "@evianta/core";
import {
  buildArtifactPdf,
  chartSvgToPng,
  composeDashboardPng,
  dataUrlToBlob,
  downloadBlob,
  fileSlug,
  tableToPng,
  type ArtifactMeta,
  type TableData,
} from "../chart-export";

export type DashboardChart = ReturnType<
  typeof DataAnalysisDashboardSchema.parse
>["charts"][number];

const chartColors = [
  "hsl(var(--primary))",
  "hsl(var(--warning))",
  "hsl(199 72% 45%)",
  "hsl(38 78% 53%)",
  "hsl(264 52% 59%)",
];

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
  }).format(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function dashboardCharts(deliverable: Deliverable): DashboardChart[] {
  if (deliverable.format !== "dashboard") return [];
  for (const section of deliverable.sections) {
    const parsed = DataAnalysisDashboardSchema.safeParse(
      asRecord(section.content)?.dashboard,
    );
    if (parsed.success) return parsed.data.charts;
  }
  return [];
}

function labelKeyOf(chart: DashboardChart): string {
  return chart.type === "pie" ? chart.nameKey : chart.categoryKey;
}

function chartTable(chart: DashboardChart): TableData {
  const labelKey = labelKeyOf(chart);
  return {
    headers: [labelKey, chart.valueKey],
    rows: chart.data.map((entry) => {
      const label = entry[labelKey];
      const value = entry[chart.valueKey];
      return [
        String(label ?? "Unknown"),
        typeof value === "number" ? formatNumber(value) : String(value ?? "—"),
      ];
    }),
  };
}

function sourceLine(chart: DashboardChart): string {
  const { source } = chart;
  return [
    `Source: ${source.documentId}`,
    source.sheet,
    source.cellRange,
    `rows ${source.rowRange.start}–${source.rowRange.end}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ChartPlot({
  chart,
  className,
  animated = true,
}: {
  chart: DashboardChart;
  className: string;
  animated?: boolean;
}) {
  const axisClass = "fill-muted-foreground text-xs";
  return (
    <div className={className} role="img" aria-label={chart.title}>
      <ResponsiveContainer width="100%" height="100%">
        {chart.type === "bar" ? (
          <BarChart data={chart.data}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis
              dataKey={chart.categoryKey}
              tick={{ className: axisClass }}
            />
            <YAxis tick={{ className: axisClass }} />
            <Tooltip />
            <Bar
              dataKey={chart.valueKey}
              fill={chartColors[0]}
              radius={[4, 4, 0, 0]}
              isAnimationActive={animated}
            />
          </BarChart>
        ) : chart.type === "line" ? (
          <LineChart data={chart.data}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis
              dataKey={chart.categoryKey}
              tick={{ className: axisClass }}
            />
            <YAxis tick={{ className: axisClass }} />
            <Tooltip />
            <Line
              type="monotone"
              dataKey={chart.valueKey}
              stroke={chartColors[0]}
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={animated}
            />
          </LineChart>
        ) : (
          <PieChart>
            <Tooltip />
            <Pie
              data={chart.data}
              dataKey={chart.valueKey}
              nameKey={chart.nameKey}
              outerRadius="80%"
              label
              isAnimationActive={animated}
            >
              {chart.data.map((entry, index) => (
                <Cell
                  key={String(entry[chart.nameKey] ?? index)}
                  fill={chartColors[index % chartColors.length]}
                />
              ))}
            </Pie>
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// Exports always render the chart at a fixed size off screen, so a narrow
// on-screen column never produces a cramped image.
async function renderChartPng(chart: DashboardChart): Promise<string> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:960px;height:540px;pointer-events:none";
  document.body.append(host);
  const root = createRoot(host);
  try {
    root.render(
      <ChartPlot chart={chart} className="h-full w-full" animated={false} />,
    );
    let svg: SVGSVGElement | null = null;
    for (let attempt = 0; attempt < 60 && !svg; attempt += 1) {
      await sleep(50);
      const candidate = host.querySelector<SVGSVGElement>(
        "svg.recharts-surface",
      );
      if (
        candidate &&
        candidate.getBoundingClientRect().width > 0 &&
        candidate.querySelector(".recharts-cartesian-axis, .recharts-pie")
      )
        svg = candidate;
    }
    if (!svg) throw new Error("The chart could not be prepared.");
    await sleep(100);
    return await chartSvgToPng(svg, chart.title);
  } finally {
    root.unmount();
    host.remove();
  }
}

function ArtifactActions({
  label,
  filename,
  onFullScreen,
  getImage,
  getPdf,
}: {
  label: string;
  filename: string;
  onFullScreen?: () => void;
  getImage: () => Promise<string>;
  getPdf: () => Promise<Blob>;
}) {
  const [pending, setPending] = useState<"image" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "image" | "pdf") {
    setError(null);
    setPending(kind);
    try {
      if (kind === "image")
        downloadBlob(dataUrlToBlob(await getImage()), `${filename}.png`);
      else downloadBlob(await getPdf(), `${filename}.pdf`);
    } catch (reason: unknown) {
      setError(
        `Download failed: ${reason instanceof Error ? reason.message : "The file could not be created."}`,
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="artifact-actions">
      {onFullScreen && (
        <button
          type="button"
          className="chip chip-neutral"
          aria-label={`View ${label} full screen`}
          onClick={onFullScreen}
        >
          <Maximize2 size={13} aria-hidden="true" /> Full screen
        </button>
      )}
      <button
        type="button"
        className="chip chip-neutral"
        aria-label={`Download ${label} as image`}
        disabled={pending !== null}
        onClick={() => void run("image")}
      >
        <ImageIcon size={13} aria-hidden="true" />{" "}
        {pending === "image" ? "Preparing..." : "Image"}
      </button>
      <button
        type="button"
        className="chip chip-neutral"
        aria-label={`Download ${label} as PDF`}
        disabled={pending !== null}
        onClick={() => void run("pdf")}
      >
        <Download size={13} aria-hidden="true" />{" "}
        {pending === "pdf" ? "Preparing..." : "PDF"}
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function FullScreenView({
  title,
  onClose,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fullscreen-overlay" />
        <Dialog.Content
          className="fullscreen-view"
          aria-describedby={undefined}
        >
          <div className="fullscreen-header">
            <Dialog.Title className="fullscreen-title">{title}</Dialog.Title>
            {actions}
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label="Close full screen"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div className="fullscreen-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DataTable({
  table,
  caption,
  rows = table.rows,
  firstRow = 1,
}: {
  table: TableData;
  caption: string;
  rows?: string[][];
  firstRow?: number;
}) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="py-1 pr-3 font-medium">
            {table.headers[0]}
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {table.headers[1]}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value], index) => (
          <tr
            className="border-b border-border/50"
            key={`${label}-${firstRow + index}`}
          >
            <th scope="row" className="py-1 pr-3 font-normal">
              {label}
            </th>
            <td className="py-1 text-right">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartView({ chart }: { chart: DashboardChart }) {
  const [dataPage, setDataPage] = useState(0);
  const [showData, setShowData] = useState(false);
  const [fullScreen, setFullScreen] = useState<"chart" | "table" | null>(null);
  const table = chartTable(chart);
  const base = fileSlug(chart.title);
  const meta: ArtifactMeta = { title: chart.title, source: sourceLine(chart) };
  const pageSize = 100;
  const pageCount = Math.ceil(table.rows.length / pageSize);
  const pageRows = table.rows.slice(
    dataPage * pageSize,
    (dataPage + 1) * pageSize,
  );
  const firstRow = dataPage * pageSize + 1;
  const lastRow = Math.min((dataPage + 1) * pageSize, table.rows.length);

  const chartImage = () => renderChartPng(chart);
  const chartPdf = async () =>
    buildArtifactPdf(meta, { image: await renderChartPng(chart) });
  const tableActions = (onFullScreen?: () => void) => (
    <ArtifactActions
      label={`${chart.title} data`}
      filename={`${base}-data`}
      onFullScreen={onFullScreen}
      getImage={async () => tableToPng(table, `${chart.title} data`)}
      getPdf={() =>
        buildArtifactPdf(
          { title: `${chart.title} data`, source: meta.source },
          { table },
        )
      }
    />
  );

  return (
    <figure className="rounded-lg border border-border bg-background p-4">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold">
        <span>{chart.title}</span>
        <ArtifactActions
          label={chart.title}
          filename={base}
          onFullScreen={() => setFullScreen("chart")}
          getImage={chartImage}
          getPdf={chartPdf}
        />
      </figcaption>
      <ChartPlot chart={chart} className="h-64 w-full" />
      <details
        className="mt-3 text-xs"
        onToggle={(event) => setShowData(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">
          View chart data
        </summary>
        {showData && (
          <div className="mt-2 overflow-x-auto">
            <div className="mb-2">
              {tableActions(() => setFullScreen("table"))}
            </div>
            <DataTable
              table={table}
              caption={`${chart.title} data`}
              rows={pageRows}
              firstRow={firstRow}
            />
            {pageCount > 1 && (
              <div className="mt-2 flex items-center justify-between gap-3">
                <p aria-live="polite" className="text-muted-foreground">
                  Rows {firstRow}–{lastRow} of {table.rows.length}
                </p>
                <div className="flex gap-2">
                  <button
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                    disabled={dataPage === 0}
                    onClick={() => setDataPage((page) => page - 1)}
                    type="button"
                  >
                    Previous
                  </button>
                  <button
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                    disabled={dataPage + 1 >= pageCount}
                    onClick={() => setDataPage((page) => page + 1)}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </details>
      <p className="mt-2 text-xs text-muted-foreground">{sourceLine(chart)}</p>
      {fullScreen === "chart" && (
        <FullScreenView
          title={chart.title}
          onClose={() => setFullScreen(null)}
          actions={
            <ArtifactActions
              label={chart.title}
              filename={base}
              getImage={chartImage}
              getPdf={chartPdf}
            />
          }
        >
          <ChartPlot chart={chart} className="fullscreen-plot" />
          <p className="mt-2 text-xs text-muted-foreground">
            {sourceLine(chart)}
          </p>
        </FullScreenView>
      )}
      {fullScreen === "table" && (
        <FullScreenView
          title={`${chart.title} data`}
          onClose={() => setFullScreen(null)}
          actions={tableActions()}
        >
          <div className="fullscreen-table text-sm">
            <DataTable table={table} caption={`${chart.title} data`} />
          </div>
        </FullScreenView>
      )}
    </figure>
  );
}

export function DashboardCharts({
  charts,
  title = "Dashboard",
}: {
  charts: DashboardChart[];
  title?: string;
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const base = fileSlug(title);
  const images = () => Promise.all(charts.map(renderChartPng));
  const actions = (onFullScreen?: () => void) => (
    <ArtifactActions
      label={title}
      filename={base}
      onFullScreen={onFullScreen}
      getImage={async () => composeDashboardPng(title, await images())}
      getPdf={async () =>
        buildArtifactPdf(
          { title, source: `${charts.length} chart(s)` },
          { images: await images() },
        )
      }
    />
  );
  return (
    <div>
      {charts.length > 0 && (
        <div className="mb-3">{actions(() => setFullScreen(true))}</div>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        {charts.map((chart) => (
          <ChartView key={chart.id} chart={chart} />
        ))}
      </div>
      {fullScreen && (
        <FullScreenView
          title={title}
          onClose={() => setFullScreen(false)}
          actions={actions()}
        >
          <div className="fullscreen-dashboard">
            {charts.map((chart) => (
              <section key={chart.id} aria-label={chart.title}>
                <h3 className="mb-2 text-sm font-semibold">{chart.title}</h3>
                <ChartPlot chart={chart} className="h-80 w-full" />
                <p className="mt-1 text-xs text-muted-foreground">
                  {sourceLine(chart)}
                </p>
              </section>
            ))}
          </div>
        </FullScreenView>
      )}
    </div>
  );
}
