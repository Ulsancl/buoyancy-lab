async function readBounded(handle, limit, tooLargeMessage) {
  const bytes = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) return bytes.subarray(0, offset);
    offset += bytesRead;
  }
  throw new Error(tooLargeMessage);
}

module.exports = { readBounded };
