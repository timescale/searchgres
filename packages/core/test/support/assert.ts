import assert from "node:assert/strict";

export async function expectSqlState(
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    assert.equal(
      (error as { readonly code?: unknown }).code,
      expectedCode,
      `expected SQLSTATE ${expectedCode}`,
    );
    return error;
  }
  assert.fail(`expected SQLSTATE ${expectedCode}, but the operation resolved`);
}
