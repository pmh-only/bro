import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Docker OpenCode configuration", () => {
  it("installs a checksum-verified multi-architecture kubectl binary", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");

    assert.match(dockerfile, /ARG KUBECTL_VERSION=1\.36\.2/);
    assert.match(dockerfile, /KUBECTL_SHA256_AMD64=[a-f0-9]{64}/);
    assert.match(dockerfile, /KUBECTL_SHA256_ARM64=[a-f0-9]{64}/);
    assert.match(dockerfile, /dl\.k8s\.io\/release\/v\$\{KUBECTL_VERSION\}\/bin\/linux\/\$\{TARGETARCH\}\/kubectl/);
    assert.match(dockerfile, /install --mode=0755 .*\/usr\/local\/bin\/kubectl/);
  });

  it("enables an inaccessible standard Docker socket at startup", async () => {
    const entrypoint = await readFile("docker/docker-entrypoint.sh", "utf8");

    assert.match(entrypoint, /docker_socket="\/var\/run\/docker\.sock"/);
    assert.match(entrypoint, /\[\[ -z "\$\{DOCKER_HOST:-\}" && -S "\$docker_socket" \]\]/);
    assert.match(entrypoint, /sudo chmod 0666 "\$docker_socket"/);
    assert.match(entrypoint, /DOCKER_HOST="unix:\/\/\$docker_socket"/);
  });

  it("serves project threads on 8080 and code-server on 8081", async () => {
    const [dockerfile, entrypoint, healthcheck] = await Promise.all([
      readFile("Dockerfile", "utf8"),
      readFile("docker/docker-entrypoint.sh", "utf8"),
      readFile("docker/docker-healthcheck.sh", "utf8"),
    ]);

    assert.match(dockerfile, /WEB_PORT=8080/);
    assert.match(dockerfile, /CODE_SERVER_PORT=8081/);
    assert.match(dockerfile, /EXPOSE 4096 8080 8081/);
    assert.match(entrypoint, /CODE_SERVER_PORT:-8081/);
    assert.match(healthcheck, /WEB_PORT:-8080/);
    assert.match(healthcheck, /CHECK_THREAD_SERVER:-true/);
  });

  it("disables the five-minute provider timeout for new and persisted configs", async () => {
    const config = JSON.parse(await readFile("docker/opencode.json", "utf8")) as {
      provider?: Record<string, { options?: { timeout?: number | false } }>;
    };
    const entrypoint = await readFile("docker/docker-entrypoint.sh", "utf8");

    assert.equal(config.provider?.anthropic?.options?.timeout, false);
    assert.equal(config.provider?.openai?.options?.timeout, false);
    assert.equal(config.provider?.openrouter?.options?.timeout, false);
    assert.match(entrypoint, /opencode-provider-timeouts\.mjs/);
  });

  it("disables the timeout for the configured model provider", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["docker/opencode-provider-timeouts.mjs", "docker/opencode.json"],
      { env: { ...process.env, OPENCODE_MODEL: "custom-provider/model" } },
    );
    const overlay = JSON.parse(stdout) as {
      provider: Record<string, { options: { timeout: number | false } }>;
    };

    assert.equal(overlay.provider.openrouter?.options.timeout, false);
    assert.equal(overlay.provider["custom-provider"]?.options.timeout, false);
  });
});
