import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function digestRecord<T extends Record<string, unknown>>(value: T, digestField: keyof T): string {
  const unsigned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== digestField) unsigned[key] = entry;
  }
  return canonicalSha256(unsigned);
}

export function hashedDiskKey(namespace: string, externalId: string): string {
  return sha256Hex(`${namespace}\0${externalId}`);
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return withAncestor(value, ancestors, () => `[${value.map((entry) => encodeCanonical(entry, ancestors)).join(",")}]`);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects and arrays.");
    }
    const record = value as Record<string, unknown>;
    return withAncestor(record, ancestors, () => {
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => {
        const entry = record[key];
        if (entry === undefined) throw new TypeError("Canonical JSON rejects undefined object values.");
        return `${JSON.stringify(key)}:${encodeCanonical(entry, ancestors)}`;
      }).join(",")}}`;
    });
  }
  throw new TypeError(`Canonical JSON rejects values of type ${typeof value}.`);
}

function withAncestor<T extends object>(value: T, ancestors: Set<object>, render: () => string): string {
  if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cyclic values.");
  ancestors.add(value);
  try {
    return render();
  } finally {
    ancestors.delete(value);
  }
}
