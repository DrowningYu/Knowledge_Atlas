export type Status = "not_understood" | "learning" | "mastered" | "skipped";
export type Concept = {
  id: string;
  title: string;
  summary: string;
  explanation: string;
  status: Status;
  notes: string;
  collapsed: boolean;
};
export type Edge = {
  id: string;
  source: string;
  target: string;
  kind: "required" | "recommended" | "related";
  reason: string;
};
export type Graph = {
  id: string;
  title: string;
  root_id: string;
  version: number;
  nodes: Concept[];
  edges: Edge[];
  updated_at: string;
};
export type MapSummary = {
  id: string;
  title: string;
  root_id: string;
  version: number;
  updated_at: string;
  node_count: number;
};
export type Operation = { op: string; [key: string]: unknown };
const desktop = !!("__TAURI_INTERNALS__" in window);
const base =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_ATLAS_API || "http://127.0.0.1:38473";
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has("token")) {
  sessionStorage.setItem("atlas-token", hash.get("token") || "");
  history.replaceState(null, "", location.pathname + location.search);
}
export function setToken(token: string) {
  sessionStorage.setItem("atlas-token", token);
}
export async function api<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("api", { method, params });
  }
  const r = await fetch(base + "/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + sessionStorage.getItem("atlas-token"),
    },
    body: JSON.stringify({ method, params }),
  });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error || r.statusText);
  return body as T;
}
export async function subscribe(
  cb: (change: { map_id: string; version: number; kind?: string }) => void,
) {
  if (desktop) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ map_id: string; version: number; kind?: string }>(
      "atlas-changed",
      (e) => cb(e.payload),
    );
  }
  const controller = new AbortController();
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const r = await fetch(base + "/events", {
          headers: {
            Authorization: "Bearer " + sessionStorage.getItem("atlas-token"),
          },
          signal: controller.signal,
        });
        if (!r.ok) throw Error();
        const reader = r.body!.getReader();
        let pending = "";
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const chunks = pending.split("\n\n");
          pending = chunks.pop() || "";
          for (const chunk of chunks) {
            const data = chunk
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (data) {
              try {
                cb(JSON.parse(data));
              } catch {}
            }
          }
        }
      } catch {}
      if (!controller.signal.aborted)
        await new Promise((r) => setTimeout(r, 2500));
    }
  })();
  return () => controller.abort();
}
export const uid = () => crypto.randomUUID();
export const newNode = (title: string): Concept => ({
  id: uid(),
  title,
  summary: "",
  explanation: "",
  status: "not_understood",
  notes: "",
  collapsed: false,
});
