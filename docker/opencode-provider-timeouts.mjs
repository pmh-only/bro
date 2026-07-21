import { readFile } from "node:fs/promises";

const providers = new Set(["anthropic", "openai", "openrouter"]);
const goalPlugin = "@prevalentware/opencode-goal-plugin@0.1.24";
let hasGoalPlugin = false;

function isGoalPlugin(entry) {
  const specifier = Array.isArray(entry) ? entry[0] : entry;
  return typeof specifier === "string" && (
    specifier === "@prevalentware/opencode-goal-plugin" ||
    specifier.startsWith("@prevalentware/opencode-goal-plugin@")
  );
}

function addModel(model) {
  if (typeof model !== "string") return;
  const separator = model.indexOf("/");
  if (separator > 0) providers.add(model.slice(0, separator));
}

addModel(process.env.OPENCODE_MODEL);

const configPath = process.argv[2];
if (configPath) {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const provider of Object.keys(config.provider ?? {})) providers.add(provider);
    addModel(config.model);
    addModel(config.small_model);
    for (const agent of Object.values(config.agent ?? {})) addModel(agent?.model);
    hasGoalPlugin = (config.plugin ?? []).some(isGoalPlugin);
  } catch (error) {
    console.error(`Unable to inspect OpenCode providers in ${configPath}:`, error.message);
  }
}

const provider = Object.fromEntries(
  [...providers].sort().map((id) => [id, { options: { timeout: false } }]),
);
process.stdout.write(JSON.stringify({
  provider,
  ...(hasGoalPlugin ? {} : { plugin: [goalPlugin] }),
}));
