// Assemble web/dist: a self-contained web root for Hostinger's Git build deploy
// (Root directory "web", output directory "dist"). Contains the built SPA, the PHP
// front controller and the PHP app under _bookstream/ (denied to the web by .htaccess).
// Private data (.env, scans) is NOT here: index.php keeps it in ../bookstream, outside
// the web root, so redeploys never overwrite it.
import { cpSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const dist = join(web, 'dist');
if (!existsSync(join(repo, 'public', 'index.html'))) throw new Error('Run vite build first');

rmSync(dist, { recursive: true, force: true });
cpSync(join(repo, 'public'), dist, { recursive: true, filter: (src) => !src.endsWith('router.php') && !src.includes('/storage') });
cpSync(join(repo, 'app'), join(dist, '_bookstream', 'app'), { recursive: true });
writeFileSync(join(dist, '_bookstream', '.htaccess'), 'Require all denied\nDeny from all\n');
console.log('Deploy web root assembled in', dist);
