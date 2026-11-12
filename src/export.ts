import fontUrl from "./assets/NotoSansCJKsc-Regular.woff2";
import type { Concept } from "./api";
export type ExportPanel = {
  id: string;
  position: { x: number; y: number };
  data: {
    title: string;
    rows: Concept[];
    selected: string;
    root: boolean;
    depth: number;
  };
};
type Shape =
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
      stroke?: string;
      radius?: number;
    }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      fill: string;
      weight?: number;
    }
  | { kind: "path"; d: string; stroke: string; dash?: string }
  | {
      kind: "circle";
      x: number;
      y: number;
      r: number;
      stroke: string;
      fill?: string;
    };
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function exportExploration(
  panels: ExportPanel[],
  path: string[],
  dark: boolean,
  format: "svg" | "png",
): Promise<Uint8Array> {
  await document.fonts.load('12px "Atlas CJK"');
  await document.fonts.ready;
  const palette = dark
    ? {
        bg: "#1b1e24",
        canvas: "#171a1f",
        surface: "#23262e",
        line: "#505968",
        divider: "#2c313b",
        text: "#d7dce6",
        muted: "#9299a5",
        accent: "#88a5d6",
        selected: "#28364e",
      }
    : {
        bg: "#ffffff",
        canvas: "#fafbfc",
        surface: "#f6f7f9",
        line: "#d0d3d9",
        divider: "#e8e9ec",
        text: "#303238",
        muted: "#92959c",
        accent: "#587bb8",
        selected: "#edf2fb",
      };
  const W = 278,
    H = 42,
    R = 77,
    F = 31,
    padding = 32;
  const minX = Math.min(...panels.map((p) => p.position.x)),
    minY = Math.min(...panels.map((p) => p.position.y));
  const width = Math.ceil(
      Math.max(...panels.map((p) => p.position.x + W)) - minX + padding * 2,
    ),
    height = Math.ceil(
      Math.max(
        ...panels.map((p) => p.position.y + H + p.data.rows.length * R + F),
      ) -
        minY +
        padding * 2,
    );
  const shapes: Shape[] = [];
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    stroke?: string,
    radius = 0,
  ) => shapes.push({ kind: "rect", x, y, w, h, fill, stroke, radius });
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d")!;
  const text = (
    x: number,
    y: number,
    value: string,
    size: number,
    fill: string,
    maxWidth = 1000,
    weight = 400,
  ) => {
    measure.font = `${weight} ${size}px "Atlas CJK", sans-serif`;
    let label = value.replace(/\s+/g, " ");
    if (measure.measureText(label).width > maxWidth) {
      while (label && measure.measureText(label + "…").width > maxWidth)
        label = label.slice(0, -1);
      label += "…";
    }
    shapes.push({ kind: "text", x, y, text: label, size, fill, weight });
  };
  const point = (p: ExportPanel) => ({
    x: p.position.x - minX + padding,
    y: p.position.y - minY + padding,
  });
  rect(0, 0, width, height, palette.canvas);
  for (let i = 0; i < panels.length - 1; i++) {
    const source = panels[i],
      target = panels[i + 1],
      a = point(source),
      b = point(target);
    const row = Math.max(
      0,
      source.data.rows.findIndex((n) => n.id === path[i]),
    );
    const sx = a.x + W,
      sy = a.y + H + row * R + R / 2,
      tx = b.x,
      ty = b.y + H + R / 2;
    shapes.push({
      kind: "path",
      d: `M ${sx} ${sy} C ${sx + 22} ${sy}, ${tx - 22} ${ty}, ${tx} ${ty}`,
      stroke: palette.line,
    });
  }
  for (const panel of panels) {
    const { x, y } = point(panel),
      rows = panel.data.rows,
      height = H + rows.length * R + F;
    rect(x, y, W, height, palette.bg, palette.line, 9);
    rect(x + 1, y + height - F, W - 2, F - 1, palette.surface, undefined, 8);
    text(x + 14, y + 25, panel.data.title, 11, palette.muted, 215, 500);
    text(
      x + W - 14,
      y + 25,
      panel.data.root ? "目标" : rows.length + " 项",
      9,
      palette.muted,
      45,
    );
    const last = shapes[shapes.length - 1];
    if (last.kind === "text") last.x -= measure.measureText(last.text).width;
    shapes.push({
      kind: "path",
      d: `M ${x} ${y + H} H ${x + W}`,
      stroke: palette.divider,
    });
    rows.forEach((node, index) => {
      const ry = y + H + index * R;
      if (panel.data.selected === node.id)
        rect(x + 1, ry, W - 2, R, palette.selected);
      const cx = x + 22,
        cy = ry + R / 2;
      const color = node.status === "learning" ? palette.accent : palette.muted;
      if (node.status === "mastered")
        shapes.push({
          kind: "path",
          d: `M ${cx - 5} ${cy} l 3 3 l 6 -7`,
          stroke: color,
        });
      else if (node.status === "skipped")
        shapes.push({
          kind: "path",
          d: `M ${cx - 5} ${cy} h 10`,
          stroke: color,
        });
      else {
        shapes.push({ kind: "circle", x: cx, y: cy, r: 5.5, stroke: color });
        if (node.status === "learning")
          shapes.push({
            kind: "path",
            d: `M ${cx} ${cy - 3} v 3 l 2 1`,
            stroke: color,
          });
      }
      text(x + 38, ry + 32, node.title, 12, palette.text, W - 70, 500);
      text(
        x + 38,
        ry + 51,
        node.summary || "添加摘要，记录你的理解",
        10,
        palette.muted,
        W - 65,
      );
      shapes.push({
        kind: "path",
        d: `M ${x + W - 23} ${cy - 4} l 4 4 l -4 4`,
        stroke: palette.muted,
      });
      shapes.push({
        kind: "path",
        d: `M ${x} ${ry + R} H ${x + W}`,
        stroke: palette.divider,
      });
    });
    text(
      x + 14,
      y + height - 12,
      panel.data.root
        ? "从目标开始，逐层探索"
        : "前置知识 · 第 " + panel.data.depth + " 层",
      9,
      palette.muted,
      W - 28,
    );
  }
  if (format === "png") {
    const scale = 2;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const shape of shapes) {
      if (shape.kind === "rect") {
        ctx.beginPath();
        ctx.roundRect(shape.x, shape.y, shape.w, shape.h, shape.radius || 0);
        ctx.fillStyle = shape.fill;
        ctx.fill();
        if (shape.stroke) {
          ctx.strokeStyle = shape.stroke;
          ctx.stroke();
        }
      } else if (shape.kind === "text") {
        ctx.font = `${shape.weight || 400} ${shape.size}px "Atlas CJK", sans-serif`;
        ctx.fillStyle = shape.fill;
        ctx.fillText(shape.text, shape.x, shape.y);
      } else if (shape.kind === "circle") {
        ctx.beginPath();
        ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
        ctx.strokeStyle = shape.stroke;
        ctx.stroke();
      } else {
        ctx.strokeStyle = shape.stroke;
        ctx.stroke(new Path2D(shape.d));
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("PNG export failed"))),
        "image/png",
      ),
    );
    return new Uint8Array(await blob.arrayBuffer());
  }
  const fontResponse = await fetch(fontUrl);
  if (!fontResponse.ok) throw Error("Unable to load bundled export font");
  const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
  let binary = "";
  for (let i = 0; i < fontBytes.length; i += 8192)
    binary += String.fromCharCode(...fontBytes.subarray(i, i + 8192));
  const font = btoa(binary);
  const content = shapes
    .map((s) =>
      s.kind === "rect"
        ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.radius || 0}" fill="${s.fill}" ${s.stroke ? `stroke="${s.stroke}"` : ""}/>`
        : s.kind === "text"
          ? `<text x="${s.x}" y="${s.y}" font-size="${s.size}" font-weight="${s.weight || 400}" fill="${s.fill}">${escape(s.text)}</text>`
          : s.kind === "circle"
            ? `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" stroke="${s.stroke}" fill="none"/>`
            : `<path d="${s.d}" stroke="${s.stroke}" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>@font-face{font-family:AtlasExport;src:url(data:font/woff2;base64,${font}) format('woff2')}text{font-family:AtlasExport,sans-serif}</style>${content}</svg>`,
  );
}
