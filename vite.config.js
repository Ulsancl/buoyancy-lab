import path from 'node:path';
import { defineConfig, normalizePath } from 'vite';

const generated = ['.security-stage-*', '.security-write-*', 'output', 'release', 'dist'];
const generatedPaths = generated.flatMap(name => [`**/${name}`, `**/${name}/**`]);
const deniedPaths = generated.flatMap(name => {
  const absolute = normalizePath(path.join(import.meta.dirname, name));
  return [absolute, `${absolute}/**`];
});
const webCsp = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

export function appConfig({ command, mode }) {
  return {
    base: './',
    envDir: false,
    define: { __ENABLE_TEST_HOOKS__: command === 'serve' || mode === 'desktop-test' },
    plugins: [{
      name: 'production-content-security-policy',
      apply: 'build',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: webCsp }, injectTo: 'head-prepend' }];
      },
    }],
    server: {
      host: '127.0.0.1',
      port: 5270,
      strictPort: true,
      watch: { ignored: generatedPaths },
      fs: {
        // Retain the Vite defaults when augmenting the deny list.
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...deniedPaths],
      },
    },
  };
}

export default defineConfig(appConfig);
