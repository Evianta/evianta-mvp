export function sourcePreviewMimeType(document: {
  name: string;
  mimeType: string;
}): string | null {
  const mimeType = document.mimeType.split(";")[0].trim().toLowerCase();
  const extension = document.name.split(".").at(-1)?.toLowerCase();
  const genericMime =
    mimeType === "" ||
    mimeType === "application/octet-stream" ||
    mimeType === "binary/octet-stream";

  if (
    mimeType === "application/pdf" ||
    mimeType === "application/x-pdf" ||
    (genericMime && extension === "pdf")
  ) {
    return "application/pdf";
  }
  if (
    ["text/csv", "application/csv", "text/x-csv"].includes(mimeType) ||
    (mimeType === "application/vnd.ms-excel" && extension === "csv") ||
    (genericMime && extension === "csv")
  ) {
    return "text/csv";
  }
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    (genericMime &&
      ["txt", "text", "md", "markdown", "json", "tsv", "tab"].includes(
        extension ?? "",
      ))
  ) {
    return "text/plain";
  }
  return mimeType.startsWith("image/") ? mimeType : null;
}
