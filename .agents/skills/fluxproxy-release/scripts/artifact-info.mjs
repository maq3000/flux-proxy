#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BUNDLE_DIR = path.join(REPO_ROOT, "src-tauri", "target", "release", "bundle");
const REPO_URL = "https://github.com/maq3000/flux-proxy";

const EXTENSION_PRIORITY = new Map([
  [".exe", 0],
  [".msi", 1],
  [".dmg", 2],
  [".appimage", 3],
  [".deb", 4],
  [".rpm", 5],
]);

const EXTENSION_KINDS = new Map([
  [".exe", "Windows Setup (.exe)"],
  [".msi", "Windows Package (.msi)"],
  [".dmg", "macOS Disk Image (.dmg)"],
  [".appimage", "Linux AppImage"],
  [".deb", "Debian Package (.deb)"],
  [".rpm", "RPM Package (.rpm)"],
]);

function parseArgs(argv) {
  let json = false;
  let versionArg = null;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node artifact-info.mjs [version] [--json]\n" +
          "Inspects src-tauri/target/release/bundle for release installers matching [version]\n" +
          "(defaults to version in package.json) and prints sizes in MiB and SHA-256 hashes."
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    } else if (versionArg === null) {
      versionArg = arg;
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      process.exit(1);
    }
  }

  return { json, versionArg };
}

function resolveVersion(versionArg) {
  let raw = versionArg;
  if (!raw) {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    if (!fs.existsSync(pkgPath)) {
      console.error(`Cannot determine version: package.json not found at ${pkgPath}`);
      process.exit(1);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    raw = pkg.version;
  }

  const normalized = String(raw || "").trim().replace(/^v/i, "");
  if (!normalized) {
    console.error("Invalid or empty version.");
    process.exit(1);
  }
  return normalized;
}

function getMatchingExtension(fileName) {
  const lower = fileName.toLowerCase();
  for (const ext of EXTENSION_PRIORITY.keys()) {
    if (lower.endsWith(ext)) {
      return ext;
    }
  }
  return null;
}

function walkFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

function detectArch(fileName, ext) {
  const lower = fileName.toLowerCase();
  if (lower.includes("aarch64") || lower.includes("arm64")) return "arm64";
  if (lower.includes("universal")) return "universal";
  if (lower.includes("amd64")) return "amd64";
  if (lower.includes("x86_64")) return "x86_64";
  if (lower.includes("x64")) return "x64";
  if (lower.includes("x86")) return "x86";
  if (ext === ".exe" || ext === ".msi") return "x64";
  return "-";
}

function formatReadmeRow(artifact, version) {
  const ext = getMatchingExtension(artifact.fileName);
  const arch = detectArch(artifact.fileName, ext);
  const link = `[📥 **${artifact.fileName}** (${artifact.sizeMiB} МБ)](${artifact.downloadUrl})`;

  if (ext === ".exe") {
    return (
      `| **Windows Setup (\`.exe\`)** | \`v${version}\` | ${arch} | ` +
      `**Рекомендуемый** автономный инсталлятор (NSIS). Автоматическое создание ярлыков на рабочем столе и в меню «Пуск», встроенный деинсталлятор. | ` +
      `${link} | \`${artifact.sha256}\` |`
    );
  }
  if (ext === ".msi") {
    return (
      `| **Windows Package (\`.msi\`)** | \`v${version}\` | ${arch} | ` +
      `Пакет Windows Installer (MSI). Оптимизирован для тихой установки (\`msiexec /i ... /qn\`) и автоматизированного развертывания через Active Directory (GPO). | ` +
      `${link} | \`${artifact.sha256}\` |`
    );
  }
  return `| **${artifact.kind}** | \`v${version}\` | ${arch} | Установочный пакет для релиза \`v${version}\`. | ${link} | \`${artifact.sha256}\` |`;
}

async function main() {
  const { json, versionArg } = parseArgs(process.argv.slice(2));
  const version = resolveVersion(versionArg);

  if (!fs.existsSync(BUNDLE_DIR)) {
    console.error(`Bundle directory does not exist: ${BUNDLE_DIR}`);
    process.exit(1);
  }

  const candidatePaths = walkFiles(BUNDLE_DIR).filter((fullPath) => {
    const fileName = path.basename(fullPath);
    const ext = getMatchingExtension(fileName);
    return ext !== null && fileName.includes(version);
  });

  if (candidatePaths.length === 0) {
    console.error(
      `No release installer artifacts matching version "${version}" found in ${BUNDLE_DIR}`
    );
    process.exit(1);
  }

  const artifacts = [];
  for (const fullPath of candidatePaths) {
    const fileName = path.basename(fullPath);
    const ext = getMatchingExtension(fileName);
    const stats = fs.statSync(fullPath);
    const sha256 = await hashFileSha256(fullPath);

    artifacts.push({
      fileName,
      absolutePath: fullPath,
      relativePath: path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/"),
      kind: EXTENSION_KINDS.get(ext) ?? "Installer",
      bytes: stats.size,
      sizeMiB: (stats.size / (1024 * 1024)).toFixed(1),
      sha256,
      downloadUrl: `${REPO_URL}/releases/download/v${version}/${fileName}`,
    });
  }

  artifacts.sort((a, b) => {
    const extA = getMatchingExtension(a.fileName);
    const extB = getMatchingExtension(b.fileName);
    const prioA = EXTENSION_PRIORITY.get(extA) ?? 99;
    const prioB = EXTENSION_PRIORITY.get(extB) ?? 99;
    if (prioA !== prioB) return prioA - prioB;
    return a.fileName.localeCompare(b.fileName, "en");
  });

  if (json) {
    console.log(JSON.stringify(artifacts, null, 2));
    return;
  }

  console.log(`FluxProxy v${version} — найдено артефактов: ${artifacts.length}\n`);
  for (const item of artifacts) {
    console.log(`- ${item.kind}: ${item.fileName}`);
    console.log(`  Path:   ${item.absolutePath}`);
    console.log(`  Size:   ${item.sizeMiB} МБ (${item.bytes} bytes)`);
    console.log(`  SHA256: ${item.sha256}`);
    console.log(`  URL:    ${item.downloadUrl}`);
  }

  console.log("\n--- Строки для таблицы README.md ---");
  for (const item of artifacts) {
    console.log(formatReadmeRow(item, version));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
