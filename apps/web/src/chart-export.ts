import type { Content, TDocumentDefinitions } from "pdfmake/interfaces.js";

export type TableData = {
  headers: string[];
  rows: string[][];
};

export type ArtifactMeta = {
  title: string;
  source?: string;
};

const IMAGE_SCALE = 2;
const TABLE_IMAGE_ROW_LIMIT = 200;

const copiedStyles = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
] as const;

export function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "chart"
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload = ""] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(header ?? "")?.[1] ?? "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function canvasPng(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

function inlineStyles(source: Element, target: Element): void {
  const computed = getComputedStyle(source);
  const style = (target as SVGElement).style;
  for (const property of copiedStyles)
    style.setProperty(property, computed.getPropertyValue(property));
  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  sourceChildren.forEach((child, index) => {
    const mirror = targetChildren[index];
    if (mirror) inlineStyles(child, mirror);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("The chart could not be rendered as an image."));
    image.src = url;
  });
}

export async function chartSvgToPng(
  svg: SVGSVGElement,
  title: string,
): Promise<string> {
  const box = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const exportWidth = Math.min(Math.max(width, 960), width * 3);
  const factor = exportWidth / width;
  const exportHeight = Math.round(height * factor);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.setAttribute("width", String(exportWidth));
  clone.setAttribute("height", String(exportHeight));
  clone.removeAttribute("class");
  const markup = new XMLSerializer().serializeToString(clone);
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
  );

  const padding = 24;
  const titleHeight = 44;
  const canvas = document.createElement("canvas");
  canvas.width = (exportWidth + padding * 2) * IMAGE_SCALE;
  canvas.height = (exportHeight + titleHeight + padding) * IMAGE_SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is not supported here.");
  context.scale(IMAGE_SCALE, IMAGE_SCALE);
  const page = getComputedStyle(document.body);
  context.fillStyle = page.backgroundColor || "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = page.color || "#111111";
  context.font = `600 18px ${page.fontFamily || "sans-serif"}`;
  context.textBaseline = "middle";
  context.fillText(title, padding, titleHeight / 2 + 4, exportWidth);
  context.drawImage(image, padding, titleHeight, exportWidth, exportHeight);
  return canvasPng(canvas);
}

export function tableToPng(table: TableData, title: string): string {
  const shown = table.rows.slice(0, TABLE_IMAGE_ROW_LIMIT);
  const font = "13px system-ui, sans-serif";
  const rowHeight = 28;
  const padding = 16;
  const titleHeight = 44;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("Image export is not supported here.");
  measure.font = font;
  const widths = table.headers.map((header, column) =>
    Math.min(
      320,
      Math.ceil(
        Math.max(
          measure.measureText(header).width,
          ...shown.map((row) => measure.measureText(row[column] ?? "").width),
        ),
      ) +
        padding * 2,
    ),
  );
  const tableWidth = widths.reduce((sum, value) => sum + value, 0);
  const truncated = table.rows.length > shown.length;
  const footerHeight = truncated ? 32 : 12;
  const width = Math.max(tableWidth + padding * 2, 360);
  const height =
    titleHeight + (shown.length + 1) * rowHeight + footerHeight + padding;
  const canvas = document.createElement("canvas");
  canvas.width = width * IMAGE_SCALE;
  canvas.height = height * IMAGE_SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is not supported here.");
  context.scale(IMAGE_SCALE, IMAGE_SCALE);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.textBaseline = "middle";
  context.fillStyle = "#16202e";
  context.font = "600 16px system-ui, sans-serif";
  context.fillText(title, padding, titleHeight / 2 + 4, width - padding * 2);

  const drawRow = (cells: string[], top: number, header: boolean) => {
    if (header) {
      context.fillStyle = "#eef2f6";
      context.fillRect(padding, top, tableWidth, rowHeight);
    }
    context.fillStyle = "#16202e";
    context.font = header ? `600 ${font}` : font;
    let left = padding;
    cells.forEach((cell, column) => {
      const columnWidth = widths[column] ?? 0;
      const numeric = column > 0 && /^-?[\d,.]+$/.test(cell);
      context.textAlign = numeric ? "right" : "left";
      context.fillText(
        cell,
        numeric ? left + columnWidth - padding : left + padding,
        top + rowHeight / 2,
        columnWidth - padding * 2,
      );
      left += columnWidth;
    });
    context.textAlign = "left";
    context.strokeStyle = "#d9e0e8";
    context.beginPath();
    context.moveTo(padding, top + rowHeight);
    context.lineTo(padding + tableWidth, top + rowHeight);
    context.stroke();
  };

  drawRow(table.headers, titleHeight, true);
  shown.forEach((row, index) =>
    drawRow(row, titleHeight + (index + 1) * rowHeight, false),
  );
  if (truncated) {
    context.fillStyle = "#5b6676";
    context.font = "12px system-ui, sans-serif";
    context.fillText(
      `Showing the first ${shown.length} of ${table.rows.length} rows. Download the PDF for every row.`,
      padding,
      titleHeight + (shown.length + 1) * rowHeight + 16,
    );
  }
  return canvasPng(canvas);
}

export type ArtifactBody =
  | { image: string }
  | { images: string[] }
  | { table: TableData };

export async function composeDashboardPng(
  title: string,
  images: string[],
): Promise<string> {
  const loaded = await Promise.all(images.map(loadImage));
  const columns = loaded.length > 1 ? 2 : 1;
  const gap = 24;
  const padding = 32;
  const headerHeight = 64;
  const cellWidth = 960;
  const heights = loaded.map(
    (image) => (image.naturalHeight / image.naturalWidth) * cellWidth,
  );
  const rowCount = Math.ceil(loaded.length / columns);
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(...heights.slice(row * columns, (row + 1) * columns)),
  );
  const width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
  const height =
    headerHeight +
    padding +
    rowHeights.reduce((sum, value) => sum + value, 0) +
    (rowCount - 1) * gap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is not supported here.");
  const page = getComputedStyle(document.body);
  context.fillStyle = page.backgroundColor || "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = page.color || "#111111";
  context.font = `600 28px ${page.fontFamily || "sans-serif"}`;
  context.textBaseline = "middle";
  context.fillText(title, padding, headerHeight / 2 + 8, width - padding * 2);
  loaded.forEach((image, index) => {
    const row = Math.floor(index / columns);
    const top =
      headerHeight +
      rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0);
    context.drawImage(
      image,
      padding + (index % columns) * (cellWidth + gap),
      top,
      cellWidth,
      heights[index]!,
    );
  });
  return canvasPng(canvas);
}

export function artifactPdfDefinition(
  meta: ArtifactMeta,
  body: ArtifactBody,
): TDocumentDefinitions {
  const content: Content[] = [
    { text: meta.title, fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
  ];
  if (meta.source)
    content.push({
      text: meta.source,
      fontSize: 8,
      color: "#555555",
      margin: [0, 0, 0, 10],
    });
  if ("image" in body) {
    content.push({ image: body.image, fit: [760, 440], alignment: "center" });
  } else if ("images" in body) {
    body.images.forEach((image, index) =>
      content.push({
        image,
        fit: [760, 400],
        alignment: "center",
        ...(index > 0 ? { pageBreak: "before" as const } : {}),
      }),
    );
  } else {
    const { headers, rows } = body.table;
    content.push({
      table: {
        headerRows: 1,
        widths: headers.map((_, index) => (index === 0 ? "*" : "auto")),
        body: [
          headers.map((header) => ({
            text: header,
            bold: true,
            fillColor: "#eef2f6",
          })),
          ...rows.map((row) =>
            row.map((cell, column) => ({
              text: cell,
              alignment:
                column > 0 && /^-?[\d,.]+$/.test(cell)
                  ? ("right" as const)
                  : ("left" as const),
            })),
          ),
        ],
      },
      layout: "lightHorizontalLines",
    });
  }
  return {
    info: { title: meta.title },
    pageSize: "A4",
    pageOrientation: "landscape",
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    content,
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: "center",
      fontSize: 8,
    }),
  };
}

export async function buildArtifactPdf(
  meta: ArtifactMeta,
  body: ArtifactBody,
): Promise<Blob> {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import("pdfmake/build/pdfmake.js"),
    import("pdfmake/build/vfs_fonts.js"),
  ]);
  pdfMake.addVirtualFileSystem(fonts);
  const buffer = await pdfMake
    .createPdf(artifactPdfDefinition(meta, body))
    .getBuffer();
  return new Blob([new Uint8Array(buffer)], { type: "application/pdf" });
}
