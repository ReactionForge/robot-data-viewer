import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('vendor', { recursive: true });
const uplot = 'node_modules/uplot/';
if (existsSync(uplot)) {
  copyFileSync(uplot + 'dist/uPlot.iife.min.js', 'vendor/uplot.js');
  copyFileSync(uplot + 'dist/uPlot.min.css', 'vendor/uplot.css');
  copyFileSync(uplot + 'LICENSE', 'vendor/uplot-LICENSE');
}
const three = 'node_modules/three/';
if (existsSync(three)) {
  const read = path => readFileSync(three + path, 'utf8');
  const sources = {
    core: read('build/three.core.min.js'),
    renderer: read('build/three.module.min.js'),
    controls: read('examples/jsm/controls/OrbitControls.js')
  };
  if (!sources.renderer.includes('./three.core.min.js') || !sources.controls.includes("from 'three'")) {
    throw new Error('Three.js module import paths changed');
  }
  writeFileSync('vendor/three-offline.js', '/* Three.js and OrbitControls. See three-LICENSE. */\n' +
    'globalThis.RDVThreeModules = ' + JSON.stringify(sources) + ';\n');
  copyFileSync(three + 'LICENSE', 'vendor/three-LICENSE');
}

const html = readFileSync('index.html', 'utf8');
const ids = new Set();
for (const [, name] of html.matchAll(/\bid="([^"]+)"/g)) {
  if (ids.has(name)) throw new Error('Duplicate entry point element: ' + name);
  ids.add(name);
}
for (const [, asset] of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
  if (!existsSync(asset)) throw new Error('Missing offline asset: ' + asset);
  if (asset === 'app.js' || /^workspace(?:-\w+)?\.js$/.test(asset)) {
    for (const [, name] of readFileSync(asset, 'utf8').matchAll(/\$\('([^']+)'\)/g)) {
      if (!ids.has(name)) throw new Error(asset + ' targets undefined element #' + name);
    }
  }
}
if (html.includes('workspace-spatial.js') && !existsSync('vendor/three-offline.js')) {
  throw new Error('Missing lazy-loaded Three.js module');
}
console.log('Offline entry point and local assets verified.');
