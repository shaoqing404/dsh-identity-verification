import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = path.resolve('.lab/native-rc3/shell/lib');
const original = fs.readFileSync(path.join(directory, 'main.js'), 'utf8');
const seam = 'import { execFile, spawn } from "node:child_process";';
if (original.split(seam).length !== 2) throw new Error('Unexpected upstream Desktop spawn import');
const derived = original.replace(seam,
  'import { execFile } from "node:child_process";\nimport { spawn } from "../native-host-launch.mjs";');
const output = path.join(directory, 'main-lab.js');
if (fs.existsSync(output) && fs.readFileSync(output, 'utf8') !== derived) {
  throw new Error('Derived shell has unexpected changes');
}
fs.writeFileSync(output, derived);
fs.writeFileSync(path.resolve('.lab/m3/shell-adaptation.json'), JSON.stringify({
  originalSha256: createHash('sha256').update(original).digest('hex'),
  derivedSha256: createHash('sha256').update(derived).digest('hex'),
  changedSeam: 'child_process spawn import',
}, null, 2) + '\n', { mode: 0o600 });
console.log('Prepared one explicit Desktop spawn adaptation');
