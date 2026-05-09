import { build, context } from 'esbuild'

const options = {
  entryPoints: ['src/plugin.js'],
  bundle: true,
  outfile: 'index.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // 'fsevents' is a darwin-only optional dep of chokidar; mark external so
  // Linux/Windows builds don't crash trying to bundle the native binding.
  external: ['electron', 'fsevents'],
  minify: true,
  sourcemap: process.argv.includes('--watch'),
  logLevel: 'info'
}

if (process.argv.includes('--watch')) {
  let ctx = await context(options)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await build(options)
}
