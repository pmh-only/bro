import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ProjectRegistry, validateRepositoryUrl } from "../src/projects.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project registry", () => {
  it("loads absolute directories and resolves normalized aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "discord-opencode-"));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, "example");
    const registryFile = join(root, "projects.json");
    await mkdir(projectDirectory);
    await writeFile(registryFile, JSON.stringify({ "Example   Project": projectDirectory }));

    const registry = await ProjectRegistry.load(registryFile);
    assert.equal(registry.resolve("  example project  ")?.directory, projectDirectory);
    assert.equal(registry.list()[0]?.alias, "Example   Project");
  });

  it("rejects relative project paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "discord-opencode-"));
    temporaryDirectories.push(root);
    const registryFile = join(root, "projects.json");
    await writeFile(registryFile, JSON.stringify({ example: "./example" }));

    await assert.rejects(ProjectRegistry.load(registryFile), /absolute directory/);
  });

  it("clones and atomically registers a project", async () => {
    const root = await mkdtemp(join(tmpdir(), "discord-opencode-"));
    temporaryDirectories.push(root);
    const registryFile = join(root, "projects.json");
    const projectsRoot = join(root, "clones");
    const fakeGit = join(root, "fake-git.mjs");
    await writeFile(
      fakeGit,
      [
        "#!/usr/bin/env node",
        'import { mkdir, writeFile } from "node:fs/promises";',
        "const destination = process.argv.at(-1);",
        "const repository = process.argv.at(-2);",
        "await mkdir(destination, { recursive: true });",
        'await writeFile(`${destination}/README.md`, "cloned\\n");',
        'if (repository.includes("unsafe")) await writeFile(`${destination}/opencode.json`, "{}\\n");',
      ].join("\n"),
    );
    await chmod(fakeGit, 0o700);

    const registry = await ProjectRegistry.load(registryFile);
    const project = await registry.cloneAndRegister({
      alias: "Example Project",
      repository: "https://github.com/example/project.git",
      projectsRoot,
      timeoutMs: 5_000,
      gitExecutable: fakeGit,
    });

    assert.equal(project.directory, join(projectsRoot, "example-project"));
    assert.equal(registry.resolve("example project")?.directory, project.directory);
    assert.deepEqual(JSON.parse(await readFile(registryFile, "utf8")), {
      "Example Project": project.directory,
    });

    await assert.rejects(
      registry.cloneAndRegister({
        alias: "Unsafe Project",
        repository: "https://github.com/example/unsafe.git",
        projectsRoot,
        timeoutMs: 5_000,
        gitExecutable: fakeGit,
      }),
      /can execute or override OpenCode configuration/,
    );
    assert.equal(registry.resolve("unsafe project"), undefined);
  });

  it("rejects local and credential-bearing repository URLs", () => {
    assert.throws(() => validateRepositoryUrl("file:///tmp/repository"), /HTTPS or SSH/);
    assert.throws(() => validateRepositoryUrl("https://user:secret@example.com/repo.git"), /cannot contain credentials/);
  });
});
