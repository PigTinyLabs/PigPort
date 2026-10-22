// Copies the renderer's non-TypeScript files next to the compiled JS.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/web/renderer');
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  cpSync(path.join(root, 'src/renderer', f), path.join(out, f));
}
// The app icon doubles as the sidebar logo and the window icon.
cpSync(path.join(root, 'build/icon.svg'), path.join(out, 'logo.svg'));
cpSync(path.join(root, 'build/icon.png'), path.join(out, 'logo.png'));
