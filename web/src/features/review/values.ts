// Showing and editing clinical fact values. The value is jsonb shaped by the
// field's JSON Schema (clinical_fields.value_schema); only the simple shapes the
// seed uses are edited here: object of strings/integers, number, string enum.
import type { ClinicalField, ConsultKeyPoint, DecisionQuestion } from "@/types/db";

type Schema = { type?: string; properties?: Record<string, { type?: string }>; enum?: string[]; required?: string[] };

export function factValueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
      .join(" · ");
  }
  return String(value);
}

export interface EditorField {
  key: string; // "" for a scalar value
  label: string;
  kind: "text" | "number" | "integer" | "enum";
  options?: string[];
  required: boolean;
}

export function editorFields(field: ClinicalField | undefined): EditorField[] {
  const schema = (field?.value_schema ?? {}) as Schema;
  if (schema.type === "object" && schema.properties) {
    return Object.entries(schema.properties).map(([key, p]) => ({
      key,
      label: key.replace(/_/g, " "),
      kind: p.type === "integer" ? "integer" : p.type === "number" ? "number" : "text",
      required: (schema.required ?? []).includes(key),
    }));
  }
  if (schema.enum) return [{ key: "", label: field?.label ?? "Value", kind: "enum", options: schema.enum, required: true }];
  if (schema.type === "number" || schema.type === "integer") {
    return [{ key: "", label: field?.label ?? "Value", kind: schema.type, required: true }];
  }
  return [{ key: "", label: field?.label ?? "Value", kind: "text", required: true }];
}

/** Form strings -> the jsonb value; null when a required part is missing. */
export function buildValue(fields: EditorField[], raw: Record<string, string>): unknown {
  const conv = (f: EditorField, v: string) => (f.kind === "number" || f.kind === "integer" ? Number(v) : v.trim());
  if (fields.length === 1 && fields[0].key === "") {
    const v = raw[""] ?? "";
    if (!v.trim()) return null;
    const out = conv(fields[0], v);
    return typeof out === "number" && !Number.isFinite(out) ? null : out;
  }
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (raw[f.key] ?? "").trim();
    if (!v) {
      if (f.required) return null;
      continue;
    }
    const out = conv(f, v);
    if (typeof out === "number" && !Number.isFinite(out)) return null;
    obj[f.key] = out;
  }
  return obj;
}

export function initialRaw(fields: EditorField[], value: unknown): Record<string, string> {
  if (fields.length === 1 && fields[0].key === "") return { "": value === null || value === undefined ? "" : String(value) };
  const v = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(fields.map((f) => [f.key, v[f.key] === undefined || v[f.key] === null ? "" : String(v[f.key])]));
}

export function answerText(k: ConsultKeyPoint, q: DecisionQuestion | undefined): string {
  if (k.kind === "explain") return k.answer_text ?? "Not stated";
  const option = q?.options.find((o) => o.value === k.answer);
  return k.answer_label ?? option?.label ?? option?.description ?? k.answer.replace(/_/g, " ");
}

export function optionLabel(o: { value: string; label?: string; description?: string }): string {
  return o.label ?? o.description ?? (o.value === "not_stated" ? "Not stated" : o.value.charAt(0).toUpperCase() + o.value.slice(1).replace(/_/g, " "));
}
