import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vscePath = path.join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
const outputPath = path.join(repoRoot, 'release', 'claude-fleet-0.1.0.vsix');

if (!fs.existsSync(vscePath)) {
  throw new Error(`Local vsce executable not found: ${vscePath}. Run npm install first.`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
await execFileAsync(
  process.execPath,
  [vscePath, 'package', '--no-dependencies', '--out', path.relative(repoRoot, outputPath)],
  {
    cwd: repoRoot,
    windowsHide: false,
    maxBuffer: 20 * 1024 * 1024,
  },
);

// On Windows, the vsce dependency can leave a non-owned stdio handle open
// after the package child has exited. This is a one-shot CLI; force a clean
// process termination after the success message so CI and local packaging do
// not hang after the VSIX has already been written.
await new Promise((resolve) =>
  process.stdout.write(
    `Portable VSIX created without bundling node_modules: ${outputPath}\n`,
    resolve,
  ),
);
process.exit(0);
