import fs from 'node:fs';
import path from 'node:path';

const [archiveArgument, destinationArgument] = process.argv.slice(2);
if (!archiveArgument || !destinationArgument) {
  throw new Error('Usage: node scripts/extract-lab-asar.mjs <official app.asar> <new .lab directory>');
}
const lab = fs.realpathSync('.lab');
const archive = fs.realpathSync(archiveArgument);
const destination = path.resolve(destinationArgument);
if (!archive.startsWith(lab + path.sep) || !destination.startsWith(lab + path.sep)) {
  throw new Error('Archive and destination must both be inside this project’s .lab');
}
if (fs.existsSync(destination)) throw new Error('Destination already exists');

const descriptor = fs.openSync(archive, 'r');
try {
  const prefix = Buffer.alloc(16);
  fs.readSync(descriptor, prefix, 0, prefix.length, 0);
  const header = Buffer.alloc(prefix.readUInt32LE(12));
  fs.readSync(descriptor, header, 0, header.length, 16);
  const tree = JSON.parse(header.toString()).files;
  const offset = 8 + prefix.readUInt32LE(4);
  let count = 0;

  function extract(entries, relative = '') {
    for (const [name, entry] of Object.entries(entries)) {
      if (name.includes('/') || name === '..' || name === '.') throw new Error('Invalid archive path');
      const local = path.join(relative, name);
      const output = path.join(destination, local);
      if (entry.files) {
        fs.mkdirSync(output, { recursive: true });
        extract(entry.files, local);
      } else if (entry.link) {
        const target = path.resolve(destination, entry.link);
        if (!target.startsWith(destination + path.sep)) throw new Error('Archive link escapes destination');
        fs.symlinkSync(path.relative(path.dirname(output), target), output);
      } else if (entry.unpacked) {
        fs.copyFileSync(path.join(archive + '.unpacked', local), output);
      } else {
        const data = Buffer.alloc(entry.size);
        if (fs.readSync(descriptor, data, 0, data.length, offset + Number(entry.offset)) !== data.length) {
          throw new Error('Truncated archive file');
        }
        fs.writeFileSync(output, data, { mode: entry.executable ? 0o755 : 0o644 });
      }
      count++;
    }
  }
  fs.mkdirSync(destination, { recursive: true });
  extract(tree);
  console.log('Extracted ' + count + ' official archive entries into a new lab directory');
} finally {
  fs.closeSync(descriptor);
}
