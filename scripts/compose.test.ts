import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

interface Service {
  readonly image?: string;
  readonly profiles?: readonly string[];
  readonly ports?: readonly string[];
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly restart?: string;
  readonly volumes?: readonly string[];
  readonly depends_on?: Readonly<
    Record<string, { readonly condition?: string }>
  >;
}

interface ComposeFile {
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes: Readonly<Record<string, unknown>>;
}

interface EvaluationConfig {
  readonly server: {
    readonly listen: { readonly host: string; readonly port: number };
  };
  readonly database: { readonly urlEnv: string };
  readonly index: {
    readonly dimensions: number;
    readonly vectorType: string;
    readonly embedding: {
      readonly model: string;
      readonly baseUrl: string;
      readonly apiKeyEnv?: string;
    };
  };
}

const compose = parse(readFileSync("compose.yaml", "utf8")) as ComposeFile;
const config = parse(
  readFileSync("docker/evaluation/searchgres.yaml", "utf8"),
) as EvaluationConfig;

function service(name: string): Service {
  const value = compose.services[name];
  assert.ok(value, `missing ${name} service`);
  return value;
}

function hasCondition(
  name: string,
  dependency: string,
  condition: string,
): void {
  assert.equal(
    service(name).depends_on?.[dependency]?.condition,
    condition,
    `${name} must wait for ${dependency} (${condition})`,
  );
}

test("evaluation Compose topology and safety remain explicit", () => {
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "db",
    "model-pull",
    "ollama",
    "provision",
    "server",
  ]);
  for (const [name, value] of Object.entries(compose.services)) {
    assert.equal(
      value.profiles,
      undefined,
      `${name} must not require a profile`,
    );
  }

  assert.deepEqual(service("server").ports, ["127.0.0.1:3000:3000"]);
  assert.equal(service("db").ports, undefined);
  assert.equal(service("ollama").ports, undefined);
  assert.deepEqual(service("db").volumes, [
    "searchgres-db:/var/lib/postgresql",
  ]);
  assert.deepEqual(service("ollama").volumes, [
    "searchgres-ollama:/root/.ollama",
  ]);
  assert.match(service("ollama").image ?? "", /^ollama\/ollama:\d/);
  assert.doesNotMatch(service("ollama").image ?? "", /:latest$/);

  hasCondition("provision", "db", "service_healthy");
  hasCondition("model-pull", "ollama", "service_healthy");
  hasCondition("server", "db", "service_healthy");
  hasCondition("server", "ollama", "service_healthy");
  hasCondition("server", "model-pull", "service_completed_successfully");
  hasCondition("server", "provision", "service_completed_successfully");

  assert.equal(service("server").restart, "unless-stopped");
  assert.equal(service("provision").restart, undefined);
  assert.equal(service("model-pull").restart, undefined);
  assert.deepEqual(service("server").healthcheck?.test, [
    "CMD",
    "searchgres",
    "--server",
    "http://127.0.0.1:3000",
    "info",
  ]);
});

test("provisioning and serving share one API-key-free evaluation contract", () => {
  const provision = service("provision");
  const server = service("server");
  assert.deepEqual(provision.command, [
    "init",
    "--config",
    "/config/searchgres.yaml",
    "--no-env-file",
    "--if-not-exists",
  ]);
  assert.deepEqual(server.command, [
    "serve",
    "--config",
    "/config/searchgres.yaml",
    "--no-env-file",
  ]);
  assert.equal(provision.image, server.image);
  assert.deepEqual(provision.volumes, server.volumes);
  assert.deepEqual(provision.environment, server.environment);

  assert.equal(config.server.listen.host, "0.0.0.0");
  assert.equal(config.server.listen.port, 3000);
  assert.equal(config.database.urlEnv, "SEARCHGRES_DATABASE_URL");
  assert.equal(config.index.dimensions, 768);
  assert.equal(config.index.vectorType, "halfvec");
  assert.equal(config.index.embedding.baseUrl, "http://ollama:11434/v1");
  assert.equal(config.index.embedding.apiKeyEnv, undefined);

  const pull = service("model-pull");
  assert.equal(pull.image, service("ollama").image);
  assert.equal(pull.command?.[0], "pull");
  assert.equal(pull.command?.[1], config.index.embedding.model);
  assert.equal(pull.environment?.OLLAMA_MODEL, config.index.embedding.model);
  assert.doesNotMatch(JSON.stringify(compose), /(?:API_KEY|OPENAI_API_KEY)/);

  assert.ok("searchgres-db" in compose.volumes);
  assert.ok("searchgres-ollama" in compose.volumes);
});
