import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

export const modelRepository = "Xenova/bge-small-en-v1.5";
export const modelRevision = "ea104dacec62c0de699686887e3f920caeb4f3e3";
export const modelBundleDirectory = "bge-small-en-v1.5";
export const modelManifestName = "neurovault-model.json";
export const modelPackageSchemaVersion = 1;

// This is the sole allowlist for the Store model package. `source` is used
// only by the explicit network fetch step; every downstream step consumes the
// flat, canonical `destination` layout plus neurovault-model.json.
export const modelFiles = [
  {
    source: "onnx/model.onnx",
    destination: "model.onnx",
    bytes: 133_093_490,
    sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
  },
  {
    source: "tokenizer.json",
    destination: "tokenizer.json",
    bytes: 711_396,
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  },
  {
    source: "config.json",
    destination: "config.json",
    bytes: 683,
    sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
  },
  {
    source: "special_tokens_map.json",
    destination: "special_tokens_map.json",
    bytes: 125,
    sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
  },
  {
    source: "tokenizer_config.json",
    destination: "tokenizer_config.json",
    bytes: 366,
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  },
];

export function expectedModelManifest() {
  return {
    schema_version: modelPackageSchemaVersion,
    repository: modelRepository,
    revision: modelRevision,
    files: modelFiles.map(({ destination, bytes, sha256 }) => ({
      path: destination,
      bytes,
      sha256,
    })),
  };
}

export function expectedModelManifestText() {
  return `${JSON.stringify(expectedModelManifest(), null, 2)}\n`;
}

export async function fileSha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function writeModelManifest(directory) {
  await writeFile(join(directory, modelManifestName), expectedModelManifestText(), {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
}

export async function verifyCanonicalModelDirectory(directory) {
  const root = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`canonical Store model package is missing: ${directory}`);
    }
    throw error;
  });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`Store model package must be a real directory: ${directory}`);
  }

  const expectedNames = [...modelFiles.map((file) => file.destination), modelManifestName].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Store model package has unexpected contents: expected ${expectedNames.join(", ")}; got ${actualNames.join(", ")}`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Store model package entry must be a regular file: ${entry.name}`);
    }
  }

  const manifestPath = join(directory, modelManifestName);
  const manifestText = await readFile(manifestPath, "utf8");
  if (manifestText !== expectedModelManifestText()) {
    throw new Error(
      `Store model manifest does not exactly identify ${modelRepository}@${modelRevision}`,
    );
  }

  for (const file of modelFiles) {
    const path = join(directory, file.destination);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Store model payload must be a regular file: ${file.destination}`);
    }
    if ((stat.mode & 0o111) !== 0) {
      throw new Error(`Store model payload must not be executable: ${file.destination}`);
    }
    if (stat.size !== file.bytes) {
      throw new Error(
        `Store model size mismatch for ${file.destination}: expected ${file.bytes}, got ${stat.size}`,
      );
    }
    const actual = await fileSha256(path);
    if (actual !== file.sha256) {
      throw new Error(
        `Store model checksum mismatch for ${file.destination}: expected ${file.sha256}, got ${actual}`,
      );
    }
  }

  const manifestStat = await lstat(manifestPath);
  if ((manifestStat.mode & 0o111) !== 0) {
    throw new Error(`${modelManifestName} must not be executable`);
  }

  return expectedModelManifest();
}

export async function copyCanonicalModelDirectory(source, destination) {
  await verifyCanonicalModelDirectory(source);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  for (const name of [...modelFiles.map((file) => file.destination), modelManifestName]) {
    await copyFile(join(source, name), join(destination, basename(name)));
    await chmod(join(destination, basename(name)), 0o644);
  }

  await verifyCanonicalModelDirectory(destination);
}
