import { pathToFileURL } from 'node:url';

export function localPathRedactor(directories) {
  const locations = directories.filter(Boolean)
    .flatMap(directory => [directory, directory.replaceAll('\\', '/'), pathToFileURL(directory).href])
    .sort((a, b) => b.length - a.length)
    .map(location => new RegExp(location.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'gi'));
  return value => locations.reduce((text, pattern) => text.replace(pattern, '[local path]'), value);
}
