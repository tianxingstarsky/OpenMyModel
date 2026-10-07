/** Display-only inventory reported by the desktop. Never use it for access or billing decisions. */
export interface NodeHardware {
  os: string;
  arch: string;
  status: "detected" | "cpu_only" | "unknown";
  devices: Array<{ name: string; backend: string; totalMemoryMiB?: number; freeMemoryMiB?: number }>;
  detectedAt: string;
  source: string;
  error?: string;
}

function label(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Reject oversized and malformed inventories without rejecting an otherwise usable node connection. */
export function parseNodeHardware(value: unknown): NodeHardware | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) return null; } catch { return null; }
  const input = value as Record<string, unknown>;
  if (!label(input.os, 64) || !label(input.arch, 64) || !label(input.source, 96) ||
      !["detected", "cpu_only", "unknown"].includes(input.status as string) ||
      !Array.isArray(input.devices) || input.devices.length > 16 ||
      typeof input.detectedAt !== "string" || input.detectedAt.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(input.detectedAt) || !Number.isFinite(Date.parse(input.detectedAt)) ||
      (input.error !== undefined && !label(input.error, 300))) return null;
  if ((input.status === "detected" && input.devices.length === 0) ||
      (input.status !== "detected" && input.devices.length !== 0)) return null;
  const devices: NodeHardware["devices"] = [];
  for (const raw of input.devices) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const device = raw as Record<string, unknown>;
    if (!label(device.name, 256) || !label(device.backend, 32)) return null;
    const clean: NodeHardware["devices"][number] = { name: device.name.trim(), backend: device.backend.trim() };
    for (const field of ["totalMemoryMiB", "freeMemoryMiB"] as const) {
      const memory = device[field];
      // Up to 16 TiB per device; NaN, infinity, negative values and strings are invalid.
      if (memory !== undefined) {
        if (typeof memory !== "number" || !Number.isFinite(memory) || memory < 0 || memory > 16 * 1024 * 1024) return null;
        clean[field] = memory;
      }
    }
    if (clean.totalMemoryMiB !== undefined && clean.freeMemoryMiB !== undefined && clean.freeMemoryMiB > clean.totalMemoryMiB) return null;
    devices.push(clean);
  }
  return { os: input.os.trim(), arch: input.arch.trim(), status: input.status as NodeHardware["status"],
    source: input.source.trim(), detectedAt: new Date(input.detectedAt).toISOString(), devices,
    ...(input.error === undefined ? {} : { error: (input.error as string).trim() }) };
}

export function readNodeHardware(value: unknown): NodeHardware | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) return null;
  try { return parseNodeHardware(JSON.parse(value)); } catch { return null; }
}
