import type { SearchResult } from "@searchgres/protocol";

const bareSelectFields = [
  "id",
  "content",
  "meta",
  "tree",
  "name",
  "temporal",
  "score",
  "hasEmbedding",
  "createdAt",
  "updatedAt",
  "version",
  "versionHash",
] as const;

type BareSelectField = (typeof bareSelectFields)[number];
type ContentRange = {
  readonly start: number | undefined;
  readonly end: number | undefined;
};

export interface ParsedSelect {
  readonly fields: ReadonlySet<BareSelectField>;
  readonly contentRange?: ContentRange;
  readonly includeFullMeta: boolean;
  readonly metaKeys: ReadonlySet<string>;
}

export type ProjectedSearchResult = Partial<SearchResult> & {
  readonly contentLength?: number;
};

export interface ProjectedSearchEnvelope {
  readonly results: readonly ProjectedSearchResult[];
}

/** Parse the CLI's comma-separated presentation selectors. */
export function parseSelectFields(value: string): ParsedSelect {
  const specs = value.split(",").map((field) => field.trim());
  if (specs.length === 0 || specs.some((field) => field === "")) {
    throw new Error("select at least one field");
  }

  const fields = new Set<BareSelectField>();
  const metaKeys = new Set<string>();
  const contentSelections = new Map<string, ContentRange | undefined>();
  let includeFullMeta = false;

  for (const spec of specs) {
    if (spec === "content") {
      fields.add("content");
      contentSelections.set("full", undefined);
      continue;
    }

    const range = parseContentRange(spec);
    if (range !== null) {
      fields.add("content");
      contentSelections.set(rangeKey(range), range);
      continue;
    }

    if (spec.startsWith("meta.")) {
      const key = spec.slice("meta.".length);
      if (key === "") throw new Error("metadata key must not be empty");
      fields.add("meta");
      metaKeys.add(key);
      continue;
    }

    if ((bareSelectFields as readonly string[]).includes(spec)) {
      const field = spec as BareSelectField;
      fields.add(field);
      if (field === "meta") includeFullMeta = true;
      continue;
    }

    if (spec.startsWith("content:")) {
      throw new Error(`invalid content range: ${spec}`);
    }
    throw new Error(`unknown field: ${spec}`);
  }

  if (contentSelections.size > 1) {
    throw new Error("only one distinct content selection may be used");
  }

  const contentSelection = contentSelections.values().next();
  return {
    fields,
    ...(contentSelection.done || contentSelection.value === undefined
      ? {}
      : { contentRange: contentSelection.value }),
    includeFullMeta,
    metaKeys,
  };
}

/** Project full wire results for presentation without changing the RPC shape. */
export function projectSearchEnvelope(
  envelope: { readonly results: readonly SearchResult[] },
  select: ParsedSelect,
): ProjectedSearchEnvelope {
  return {
    results: envelope.results.map((result) =>
      projectSearchResult(result, select),
    ),
  };
}

export function projectSearchResult(
  result: SearchResult,
  select: ParsedSelect,
): ProjectedSearchResult {
  const projected: Partial<SearchResult> & { contentLength?: number } = {};

  if (select.fields.has("id")) projected.id = result.id;
  if (select.fields.has("content")) {
    if (select.contentRange === undefined) projected.content = result.content;
    else {
      const points = [...result.content];
      projected.content = points
        .slice(select.contentRange.start, select.contentRange.end)
        .join("");
      projected.contentLength = points.length;
    }
  }
  if (select.fields.has("meta")) {
    if (select.includeFullMeta) projected.meta = result.meta;
    else {
      const selectedMeta: typeof result.meta = {};
      for (const key of select.metaKeys) {
        if (!Object.hasOwn(result.meta, key)) continue;
        const value = result.meta[key];
        if (value === undefined) continue;
        // Define rather than assign so a literal "__proto__" metadata key is
        // projected as data instead of invoking Object.prototype's setter.
        Object.defineProperty(selectedMeta, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      projected.meta = selectedMeta;
    }
  }
  if (select.fields.has("tree")) projected.tree = result.tree;
  if (select.fields.has("name")) projected.name = result.name;
  if (select.fields.has("temporal")) projected.temporal = result.temporal;
  if (select.fields.has("score")) projected.score = result.score;
  if (select.fields.has("hasEmbedding")) {
    projected.hasEmbedding = result.hasEmbedding;
  }
  if (select.fields.has("createdAt")) projected.createdAt = result.createdAt;
  if (select.fields.has("updatedAt")) projected.updatedAt = result.updatedAt;
  if (select.fields.has("version")) projected.version = result.version;
  if (select.fields.has("versionHash")) {
    projected.versionHash = result.versionHash;
  }

  return projected;
}

function parseContentRange(spec: string): ContentRange | null {
  const shorthand = /^content:(\d+)$/.exec(spec);
  if (shorthand?.[1] !== undefined) {
    return { start: undefined, end: safeOffset(shorthand[1], spec) };
  }

  const range = /^content:(-?\d*)\.\.(-?\d*)$/.exec(spec);
  if (range === null) return null;
  const startText = range[1] ?? "";
  const endText = range[2] ?? "";
  if (startText === "" && endText === "") {
    throw new Error(`invalid content range: ${spec}`);
  }
  return {
    start: startText === "" ? undefined : safeOffset(startText, spec),
    end: endText === "" ? undefined : safeOffset(endText, spec),
  };
}

function safeOffset(value: string, spec: string): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`invalid content range: ${spec}`);
  }
  return offset;
}

function rangeKey(range: ContentRange): string {
  return `${range.start ?? ""}..${range.end ?? ""}`;
}
