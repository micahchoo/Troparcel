import { build, context } from 'esbuild'

const options = {
  entryPoints: ['src/plugin.js'],
  bundle: true,
  outfile: 'index.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  minify: false,
  sourcemap: true,
  logLevel: 'info'
}

if (process.argv.includes('--watch')) {
  let ctx = await context(options)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await build(options)
}
