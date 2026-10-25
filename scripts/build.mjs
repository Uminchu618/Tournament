import {mkdir, copyFile, cp, rm} from 'node:fs/promises';
import {build} from 'esbuild';

await rm('dist/public', {recursive: true, force: true});
await mkdir('dist/public/assets', {recursive: true});
await Promise.all(['index.html', 'styles.css'].map(name => copyFile(name, `dist/public/${name}`)));
await cp('assets', 'dist/public/assets', {recursive: true});
await build({entryPoints: ['src/app.js'], outfile: 'dist/public/app.js', bundle: true, format: 'esm', target: ['es2022'], minify: true, legalComments: 'eof'});
console.log('公開用アセットをdist/publicへ生成しました');
