import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const privateHostname = ["a2al", "wpperez", "com"].join(".");
const portableRoots = ["README.md", "apps", "compose.yml", "docs", "examples", "ops", "package.json", "packages", "scripts"];
const textExtensions = new Set([".caddyfile", ".json", ".md", ".mjs", ".sh", ".ts", ".yaml", ".yml"]);
const ignoredDirectories = new Set(["dist", "node_modules", "coverage", ".git"]);

function filesAt(path) {
  const absolutePath = join(root, path);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return [absolutePath];

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    return filesAt(join(path, entry.name));
  });
}

const portableFiles = portableRoots
  .flatMap(filesAt)
  .filter((file) => textExtensions.has(file.slice(file.lastIndexOf("."))));
const failures = [];

for (const file of portableFiles) {
  const contents = readFileSync(file, "utf8");
  if (contents.includes(privateHostname)) {
    failures.push(`${relative(root, file)} contains the private production hostname`);
  }
}

const compose = readFileSync(join(root, "compose.yml"), "utf8");
function composeServiceBlock(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return compose.match(new RegExp(`^  ${escapedName}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_-]*:|^volumes:|^networks:|$)`, "m"))?.[0] ?? "";
}

if (["postgres", "redis"].some((service) => /^\s{4}ports:/m.test(composeServiceBlock(service)))) {
  failures.push("compose.yml publishes a Postgres or Redis host port");
}
if (/\bcaddy\b/i.test(compose)) failures.push("compose.yml must not include Caddy");
if (!compose.includes("A2A_PUBLIC_BASE_URL: ${A2A_PUBLIC_BASE_URL:?set A2A_PUBLIC_BASE_URL}")) {
  failures.push("compose.yml must require A2A_PUBLIC_BASE_URL from the environment");
}

const caddyExample = readFileSync(join(root, "ops/caddy/Caddyfile.example"), "utf8");
if (!caddyExample.includes("a2a.example.com")) failures.push("Caddyfile.example must use a2a.example.com");

const productionExample = readFileSync(join(root, ".env.production.example"), "utf8");
const forbiddenCredentialValues = ["agent_lobby_dev", "strong-password", "changeme"];
for (const value of forbiddenCredentialValues) {
  if (productionExample.toLowerCase().includes(value)) {
    failures.push(`.env.production.example includes a non-placeholder credential value (${value})`);
  }
}
if (!/^POSTGRES_PASSWORD=<replace-with-generated-password>$/m.test(productionExample)) {
  failures.push(".env.production.example must use the POSTGRES_PASSWORD placeholder");
}
if (!/^DATABASE_URL=postgres:\/\/agent_lobby:<replace-with-generated-password>@postgres:5432\/agent_lobby$/m.test(productionExample)) {
  failures.push(".env.production.example must use a placeholder database password");
}

if (failures.length > 0) {
  console.error("Portability contract failed:\n- " + failures.join("\n- "));
  process.exit(1);
}

console.log(`Portability contract passed (${portableFiles.length} portable text files scanned).`);
