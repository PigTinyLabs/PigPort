// Prepare the complete frontend for the Tauri webview.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/web/renderer');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/renderer/app.ts')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  sourcemap: true,
});
for (const f of ['index.html', 'styles.css']) {
  cpSync(path.join(root, 'src/renderer', f), path.join(out, f));
}
// The app icon doubles as the sidebar logo and the window icon.
cpSync(path.join(root, 'build/icon.svg'), path.join(out, 'logo.svg'));
cpSync(path.join(root, 'build/icon.png'), path.join(out, 'logo.png'));
