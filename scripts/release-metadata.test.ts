import { expect, test } from "bun:test";

const repository = "timescale/searchgres-js";
const github = `https://github.com/${repository}`;

function text(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

test("project branding keeps the published package identity and canonical metadata", async () => {
  const manifest = JSON.parse(await text("packages/core/package.json"));
  expect(manifest.name).toBe("searchgres");
  expect(manifest.repository).toEqual({
    type: "git",
    url: `git+${github}.git`,
    directory: "packages/core",
  });
  expect(manifest.homepage).toBe(`${github}#readme`);
  expect(manifest.bugs.url).toBe(`${github}/issues`);

  const readme = await text("README.md");
  expect(readme.startsWith("# searchgres.js\n")).toBe(true);
  expect(readme).toContain("searchgres.js is published on npm as `searchgres`");
  expect(readme).toContain(`git clone ${github}.git\ncd searchgres-js`);
});

test("installer defaults use the canonical repository but retain binary names", async () => {
  // Fixture-based installer tests override both network endpoints. Check the
  // actual defaults too, without contacting a not-yet-renamed repository.
  const installer = await text("install.sh");
  expect(installer).toContain(`REPOSITORY="${repository}"`);
  expect(installer).toContain('BINARIES="searchgres"');
  expect(installer).toContain(
    "${SEARCHGRES_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/download}",
  );
  expect(installer).toContain(
    "${SEARCHGRES_LATEST_RELEASE_URL:-https://github.com/${REPOSITORY}/releases/latest}",
  );

  const installation = await text("docs/installation.md");
  const command = `curl -fsSL https://raw.githubusercontent.com/${repository}/main/install.sh |`;
  expect(installation).toContain(`${command} sh`);
  expect(installation).toContain(`${command} \\\n`);
  expect(installation).toMatch(/SEARCHGRES_VERSION=v\d+\.\d+\.\d+ sh/);
});
