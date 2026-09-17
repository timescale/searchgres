import { expect, test } from "bun:test";
import { YAML } from "bun";

test("Compose exposes only DB/provider on loopback and uses direct CLI jobs", async () => {
  const config = YAML.parse(await Bun.file("compose.yaml").text());
  expect(Object.keys(config.services).sort()).toEqual([
    "db",
    "init",
    "model",
    "ollama",
    "worker",
  ]);
  for (const service of [config.services.db, config.services.ollama]) {
    expect(service.ports).toHaveLength(1);
    expect(service.ports[0]).toStartWith("127.0.0.1:");
  }
  expect(config.services.init.command[0]).toBe("init");
  expect(config.services.init.command).toContain("--if-not-exists");
  expect(config.services.worker.command.slice(0, 2)).toEqual([
    "embeddings",
    "worker",
  ]);
  expect(config.services.worker.depends_on.init.condition).toBe(
    "service_completed_successfully",
  );
  expect(config.services.worker.depends_on.model.condition).toBe(
    "service_completed_successfully",
  );
  expect(config.services.init.depends_on.db.condition).toBe("service_healthy");
  expect(config.services.worker.stop_grace_period).toBe("70s");
  for (const name of ["init", "worker"]) {
    expect(config.services[name].build.dockerfile).toBe(
      "docker/Dockerfile.cli",
    );
    expect(config.services[name].volumes[0]).toEndWith(":ro");
  }
  const image = await Bun.file("docker/Dockerfile.cli").text();
  expect(image).toContain('ENTRYPOINT ["searchgres"]');
  expect(image).not.toContain("packages/server");
  const evaluation = YAML.parse(
    await Bun.file("docker/evaluation/searchgres.yaml").text(),
  );
  expect(evaluation.embedding.model).toBe(config.services.model.command[1]);
  expect(evaluation.embedding.baseUrlEnv).toBe("SEARCHGRES_EMBEDDING_BASE_URL");
  expect(evaluation.server).toBeUndefined();
});
