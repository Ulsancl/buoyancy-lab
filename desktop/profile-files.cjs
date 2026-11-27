const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const WINDOW_LIMIT = 4096;
const LOG_LIMIT = 128 * 1024;
const { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY, O_CREAT, O_WRONLY } = fs.constants;
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;

function requireRealDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || normalized(fs.realpathSync(directory)) !== normalized(directory)) {
    throw new Error('The application profile must be a real directory');
  }
}

function openProfileDirectory(appData, appName, override) {
  if (!override) {
    fs.mkdirSync(appData, { recursive: true });
    override = path.join(fs.realpathSync(appData), appName);
  }
  if (!path.isAbsolute(override)) throw new Error('BUOYANCY_LAB_DATA_DIR must be absolute');
  const directory = path.resolve(override);
  const missing = [];
  let ancestor = directory;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.push(ancestor);
    ancestor = path.dirname(ancestor);
  }
  requireRealDirectory(ancestor);
  for (const parent of missing.reverse()) {
    try { fs.mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    requireRealDirectory(parent);
  }
  return directory;
}

function regularFile(target) {
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Invalid profile file');
  return info;
}

function verifyOpened(fd, target) {
  const opened = fs.fstatSync(fd), current = regularFile(target);
  if (!current || !opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error('Profile file changed while opening');
  }
  return opened;
}

function readWindowState(directory) {
  try {
    requireRealDirectory(directory);
    const target = path.join(directory, 'window.json');
    const original = regularFile(target);
    if (!original || original.size > WINDOW_LIMIT) return {};
    const fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      verifyOpened(fd, target);
      const bytes = Buffer.alloc(WINDOW_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length > WINDOW_LIMIT) return {};
      const value = JSON.parse(bytes.toString('utf8', 0, length));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } finally { fs.closeSync(fd); }
  } catch { /* The window can open without saved bounds. */ }
  return {};
}

function writeWindowState(directory, value) {
  requireRealDirectory(directory);
  const target = path.join(directory, 'window.json');
  const temp = path.join(directory, `window-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    requireRealDirectory(directory);
    regularFile(target);
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* The temporary name is normally gone. */ }
  }
}

function appendLog(directory, message) {
  requireRealDirectory(directory);
  const target = path.join(directory, 'desktop.log');
  regularFile(target);
  const fd = fs.openSync(target, O_CREAT | O_WRONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const opened = verifyOpened(fd, target);
    const line = Buffer.from(`${new Date().toISOString()} ${String(message).replace(/[\r\n]/g, ' ').slice(0, 2048)}\n`);
    let position = opened.size;
    if (position + line.length > LOG_LIMIT) {
      fs.ftruncateSync(fd, 0);
      position = 0;
    }
    for (let offset = 0; offset < line.length;) {
      const count = fs.writeSync(fd, line, offset, line.length - offset, position + offset);
      if (!count) throw new Error('Could not write the profile log');
      offset += count;
    }
  } finally { fs.closeSync(fd); }
}

module.exports = { openProfileDirectory, readWindowState, writeWindowState, appendLog };
