import {
  type Attributes,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SearchgresError } from "./errors.ts";
import { LIBRARY_VERSION } from "./version.ts";

const tracer = trace.getTracer("searchgres", LIBRARY_VERSION);

interface OperationOptions {
  readonly schema?: string;
  readonly attributes?: Attributes;
}

type OperationCallback<T> = (span: Span) => Promise<T>;

/** Run one asynchronous caller-visible operation in the active trace context. */
export async function runOperation<T>(
  name: string,
  options: OperationOptions,
  callback: OperationCallback<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      attributes: operationAttributes(options),
    },
    async (span) => {
      try {
        return await callback(span);
      } catch (error) {
        recordOperationError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Run short synchronous lifecycle setup without making its span active. This
 * prevents detached work started by the callback from inheriting an ended span.
 */
export function runNonActiveOperation<T>(
  name: string,
  options: OperationOptions,
  callback: (span: Span) => T,
): T {
  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes: operationAttributes(options),
  });
  try {
    return callback(span);
  } catch (error) {
    recordOperationError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** Start background work outside the caller's active trace context. */
export function runDetached<T>(callback: () => T): T {
  return context.with(ROOT_CONTEXT, callback);
}

function operationAttributes(options: OperationOptions): Attributes {
  return {
    ...(options.schema === undefined
      ? {}
      : { "searchgres.index.schema": options.schema }),
    ...options.attributes,
  };
}

function recordOperationError(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setAttribute("error.type", exception.name);
  if (error instanceof SearchgresError) {
    span.setAttribute("searchgres.error.code", error.code);
  }
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message:
      error instanceof SearchgresError ? error.code : exception.name || "Error",
  });
}
