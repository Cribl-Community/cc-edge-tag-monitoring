import { mkdir, rm, cp, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Materializes the Cribl pack layout at the repo root so the tag can be
// installed via "Import from Git" (Cribl reads package.json + static/ + default/
// from the repo root). Run in CI on a tag; the release workflow then force-adds
// static/, default/, and package.json onto the tagged commit. Not intended to be
// run against a working tree you plan to keep — it rewrites the root package.json
// down to the pack manifest. See CONTRIBUTOR_SETUP.md.

const rootDir = join(import.meta.dirname, '..');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CRIBL_CREATE_APP_SCRIPT_VERSION = '0.5.0';

// Only these keys belong in the published pack manifest (mirrors pkgutil.mjs).
const MANIFEST_KEYS = [
  'name',
  'version',
  'displayName',
  'description',
  'author',
  'license',
  'cribl',
  'tags',
];

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseVersionArg() {
  const args = parseArgs({ options: { version: { type: 'string' } } });
  const raw = args.values.version;
  if (!raw) {
    throw new Error('Missing required --version "X.Y.Z" argument.');
  }
  // A "-staging" tag (e.g. v1.0.0-staging) publishes the same pack version as
  // prod; strip the suffix so the manifest version matches the built .tgz. This
  // mirrors the sed the release workflow applies to the package step.
  const version = raw.replace(/-staging$/, '');
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid version "${raw}". Expected X.Y.Z (optionally with a -staging suffix).`);
  }
  return version;
}

const version = parseVersionArg();

const distDir = join(rootDir, 'dist');
if (!(await pathExists(distDir))) {
  throw new Error('dist folder not found. Run npm run build (or npm run package) first.');
}

// static/ <- built app assets (contents of dist/).
const staticDir = join(rootDir, 'static');
await rm(staticDir, { recursive: true, force: true });
await mkdir(staticDir, { recursive: true });
await cp(distDir, staticDir, { recursive: true });

// default/ <- optional Cribl app config (proxies/policies).
const defaultDir = join(rootDir, 'default');
await rm(defaultDir, { recursive: true, force: true });
await mkdir(defaultDir, { recursive: true });
for (const name of ['proxies.yml', 'policies.yml']) {
  const src = join(rootDir, 'config', name);
  if (await pathExists(src)) {
    await cp(src, join(defaultDir, name));
  }
}

// package.json <- trimmed pack manifest at repo root, with the released version.
const rootPackageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const manifest = Object.fromEntries(
  MANIFEST_KEYS.filter((k) => rootPackageJson?.[k]).map((k) => [k, rootPackageJson[k]])
);
manifest.version = version;
manifest.cribl = {
  ...(manifest.cribl ?? {}),
  createAppScriptVersion: CRIBL_CREATE_APP_SCRIPT_VERSION,
};
manifest.tags = {
  ...(manifest.tags ?? {}),
  product: manifest.tags?.product ?? [],
};

await writeFile(join(rootDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared Git pack layout for ${manifest.name}@${version} (static/, default/, package.json).`);
