import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const binaries = ["searchgres", "searchgres-server", "searchgres-mcp"];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("installer verifies and installs all release binaries", async () => {
  const fixture = await releaseFixture();
  try {
    const result = await runInstaller(
      fixture.baseUrl,
      fixture.installDirectory,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Checksum verified");

    for (const binary of binaries) {
      const installed = join(fixture.installDirectory, binary);
      expect(await Bun.file(installed).exists()).toBe(true);
      const child = Bun.spawn({ cmd: [installed], stdout: "pipe" });
      expect(await child.exited).toBe(0);
      expect((await new Response(child.stdout).text()).trim()).toBe(binary);
    }
  } finally {
    fixture.server.stop(true);
  }
});

test("a checksum failure installs nothing", async () => {
  const fixture = await releaseFixture("searchgres-mcp");
  try {
    const result = await runInstaller(
      fixture.baseUrl,
      fixture.installDirectory,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Checksum mismatch for searchgres-mcp-");
    expect(await Bun.file(fixture.installDirectory).exists()).toBe(false);
  } finally {
    fixture.server.stop(true);
  }
});

async function releaseFixture(corruptChecksum?: string): Promise<{
  readonly server: ReturnType<typeof Bun.serve>;
  readonly baseUrl: string;
  readonly installDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "searchgres-installer-test-"));
  directories.push(directory);
  const installDirectory = join(directory, "bin");
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const assets = new Map<string, string>();
  for (const binary of binaries) {
    const asset = `${binary}-${os}-${arch}`;
    const body = `#!/bin/sh\nprintf '%s\\n' '${binary}'\n`;
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    assets.set(`/v-test/${asset}`, body);
    assets.set(
      `/v-test/${asset}.sha256`,
      `${binary === corruptChecksum ? "0".repeat(64) : hash}  ${asset}\n`,
    );
  }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const body = assets.get(new URL(request.url).pathname);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body);
    },
  });
  return {
    server,
    baseUrl: server.url.toString().replace(/\/$/, ""),
    installDirectory,
  };
}

async function runInstaller(
  baseUrl: string,
  installDirectory: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn({
    cmd: ["/bin/sh", installer],
    env: {
      ...process.env,
      SEARCHGRES_VERSION: "v-test",
      SEARCHGRES_RELEASE_BASE_URL: baseUrl,
      SEARCHGRES_INSTALL_DIR: installDirectory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
