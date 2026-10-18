import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  excluded = new Set([
    ".git",
    "node_modules",
    ".local",
    "private",
    "incoming",
    "avatars",
    "dist",
    "release",
  ]);
const directories = new Set([
  "app",
  "desktop",
  "scripts",
  "tests",
  "docs",
  ".github",
]);
const rootFiles = new Set([
  "README.md",
  "AGENTS.md",
  "LICENSE",
  "NOTICE.md",
  "ASSET_POLICY.md",
  "SECURITY.md",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".gitattributes",
  ".node-version",
]);
const errors = [],
  files = [];
async function walk(directory, relative = "") {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!relative && excluded.has(entry.name)) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      errors.push(`Symbolic link: ${name}`);
      continue;
    }
    if (
      !relative &&
      !(entry.isDirectory()
        ? directories.has(entry.name)
        : rootFiles.has(entry.name))
    ) {
      errors.push(`Unreviewed root entry: ${name}`);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(path.join(directory, entry.name), name);
      continue;
    }
    files.push(name);
    const stat = await fs.stat(path.join(root, name));
    if (stat.size > 3 * 1024 * 1024)
      errors.push(`Unexpected large source file: ${name}`);
    if (/\.(?:png|ico)$/.test(name)) continue;
    if (
      !/\.(?:md|mjs|cjs|js|json|html|css|yml)$/.test(name) &&
      !rootFiles.has(name)
    ) {
      errors.push(`Unreviewed source type: ${name}`);
      continue;
    }
    const text = await fs.readFile(path.join(root, name), "utf8");
    if (
      /(?<![a-z])(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\s]+/i.test(
        text,
      )
    )
      errors.push(`Personal absolute path: ${name}`);
    if (
      /\b(?:gh[pousr]_[a-zA-Z0-9]{25,}|github_pat_[a-zA-Z0-9_]{25,}|sk-[a-zA-Z0-9]{25,})\b/.test(
        text,
      )
    )
      errors.push(`Credential-like value: ${name}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
      errors.push(`Private key: ${name}`);
    if (
      /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(
        text,
      )
    )
      errors.push(`Unreviewed email: ${name}`);
  }
}
await walk(root);
for (const required of [
  "README.md",
  "AGENTS.md",
  "SECURITY.md",
  "LICENSE",
  "docs/AGENT_WORKFLOW.md",
  "docs/BEGINNER_GUIDE.md",
  "docs/OBS_GUIDE.md",
  "docs/THREAT_MODEL.md",
  "docs/VALIDATION.md",
])
  if (!files.includes(required))
    errors.push(`Missing required document: ${required}`);
console.log(JSON.stringify({ files: files.length, errors }));
if (errors.length) process.exitCode = 1;
