import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function readPdf(data: Uint8Array): Promise<{
  text: string;
  pages: number;
}> {
  const task = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
  });
  const document = await task.promise;
  try {
    const text: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      text.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
      );
    }
    return { text: text.join("\n"), pages: document.numPages };
  } finally {
    await task.destroy();
  }
}
