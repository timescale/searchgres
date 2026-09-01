import { describe, expect, test } from "bun:test";
import { inputFormat, parseStructured } from "./format.ts";

describe("structured input detection", () => {
  test("sniffs JSON, NDJSON, YAML, and Markdown from stdin", () => {
    expect(inputFormat(undefined, "-", '{"content":"one"}')).toBe("json");
    expect(
      inputFormat(undefined, "-", '{"content":"one"}\n{"content":"two"}\n'),
    ).toBe("ndjson");
    expect(inputFormat(undefined, "-", "content: one\ntree: docs\n")).toBe(
      "yaml",
    );
    expect(inputFormat(undefined, "-", "---\ntree: docs\n---\nbody")).toBe(
      "md",
    );
  });

  test("an explicit format and a recognized extension take precedence", () => {
    expect(inputFormat("yaml", "record.json", "{}")).toBe("yaml");
    expect(inputFormat(undefined, "records.jsonl", "[]")).toBe("ndjson");
  });
});

describe("Markdown records", () => {
  test("maps YAML frontmatter and the body to one record", () => {
    expect(
      parseStructured(
        "---\ntree: docs.notes\nname: vacuum\nmeta:\n  kind: note\n---\nVacuum reclaims tuples.\n",
        "md",
        true,
      ),
    ).toEqual({
      tree: "docs.notes",
      name: "vacuum",
      meta: { kind: "note" },
      content: "Vacuum reclaims tuples.\n",
    });
  });

  test("plain Markdown is record content", () => {
    expect(parseStructured("# Heading\n", "md", true)).toEqual({
      content: "# Heading\n",
    });
  });
});
