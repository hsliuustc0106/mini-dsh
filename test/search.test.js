import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'

const slashes = (text) => text.replaceAll('\\', '/')

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-search-'))
  let app
  t.after(async () => {
    if (app) await app.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  app = await boot({ workspace: dir, ...options })
  return { dir, app }
}

test('glob and grep run through the agent without approval and record their results', async (t) => {
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const provider = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [
      call('find', 'glob', { pattern: '*.js', path: 'src' }),
      call('search', 'grep', { pattern: 'needle', path: 'src', include: '*.js' }),
    ] },
    { role: 'assistant', content: 'done' },
  ])
  let approvals = 0
  const { dir, app } = await setup(t, { provider, approve: () => { approvals++; return false } })
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'one.js'), 'first\nneedle\n')

  await app.ctx.agent.turn('Find the needle')
  assert.equal(approvals, 0)
  const decisions = app.ctx.session.events.filter((event) => event.type === 'permission.decided')
  assert.deepEqual(decisions.map(({ name, decision }) => [name, decision]), [['glob', 'allow'], ['grep', 'allow']])
  const results = app.ctx.session.events.filter((event) => event.type === 'tool.finished')
  assert.match(slashes(results[0].result), /src\/one\.js/)
  assert.match(results[1].result, /Line 2: needle/)
  assert.ok(results.every((event) => app.ctx.session.events.find((start) => start.type === 'tool.started' && start.callId === event.callId).seq < event.seq))
  const schemas = provider.sent[0].tools
  assert.deepEqual(schemas.find((tool) => tool.function.name === 'glob').function.parameters.required, ['pattern'])
  assert.deepEqual(Object.keys(schemas.find((tool) => tool.function.name === 'grep').function.parameters.properties), ['pattern', 'path', 'include'])
})

test('glob searches hidden and ignored files, excludes VCS, and treats arguments as data', async (t) => {
  const { dir, app } = await setup(t)
  await mkdir(join(dir, 'src', '.hidden'), { recursive: true })
  await mkdir(join(dir, '.git'))
  await mkdir(join(dir, '--leading'))
  await writeFile(join(dir, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(dir, 'ignored.ts'), 'ignored')
  await writeFile(join(dir, '.git', 'secret.ts'), 'private')
  await writeFile(join(dir, 'src', '.hidden', 'one.ts'), 'hidden')
  await writeFile(join(dir, 'src', 'two.ts'), 'normal')
  await writeFile(join(dir, '--leading', 'three.ts'), 'leading')

  const result = slashes(await app.ctx.tools.run('glob', { pattern: '*.ts' }))
  assert.match(result, /ignored\.ts/)
  assert.match(result, /src\/\.hidden\/one\.ts/)
  assert.match(result, /src\/two\.ts/)
  assert.doesNotMatch(result, /secret\.ts/)
  assert.match(slashes(await app.ctx.tools.run('glob', { pattern: '*.ts', path: '--leading' })), /--leading\/three\.ts/)
  assert.match(slashes(await app.ctx.tools.run('glob', { pattern: '*.ts', path: join(dir, 'src') })), /src\/two\.ts/)
  assert.equal(await app.ctx.tools.run('glob', { pattern: '*', path: '.git' }), 'No files found')
  assert.equal(await app.ctx.tools.run('glob', { pattern: '*.not-found' }), 'No files found')
  assert.equal(await app.ctx.tools.run('glob', { pattern: '$(touch injected)*' }), 'No files found')
  await assert.rejects(access(join(dir, 'injected')))
  await assert.rejects(app.ctx.tools.run('glob', { pattern: ' ' }), /pattern must be a non-empty string/)
  await assert.rejects(app.ctx.tools.run('glob', { pattern: '*', path: '' }), /path must be a non-empty string/)
})

test('grep supports DSH regex and include arguments and reports search errors', async (t) => {
  const { dir, app } = await setup(t)
  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, '.git'))
  await writeFile(join(dir, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(dir, 'ignored.ts'), 'needle ignored\n')
  await writeFile(join(dir, 'src', 'one.ts'), 'first\nneedle one\nneedles two\n')
  await writeFile(join(dir, 'src', 'two.js'), 'needle three\n')
  await writeFile(join(dir, 'src', 'skip.txt'), 'needle four\n')

  const result = slashes(await app.ctx.tools.run('grep', { pattern: 'needles?', path: 'src', include: '*.{ts,js}' }))
  assert.match(result, /Found 3 matches/)
  assert.match(result, /src\/one\.ts\nLine 2: needle one\nLine 3: needles two/)
  assert.match(result, /src\/two\.js\nLine 1: needle three/)
  assert.doesNotMatch(result, /ignored\.ts|skip\.txt/)
  assert.doesNotMatch(await app.ctx.tools.run('grep', { pattern: 'needle' }), /ignored\.ts/)
  assert.match(await app.ctx.tools.run('grep', { pattern: 'needle', path: 'src/skip.txt', include: '' }), /Line 1: needle four/)
  assert.equal(await app.ctx.tools.run('grep', { pattern: 'absent', path: 'src' }), 'No matches found')
  await assert.rejects(app.ctx.tools.run('grep', { pattern: '[' }), /grep search failed/)
  await assert.rejects(app.ctx.tools.run('grep', { pattern: 'needle', path: 'missing' }), /grep search failed/)
  await assert.rejects(app.ctx.tools.run('grep', { pattern: '' }), /pattern must be a non-empty string/)
  await assert.rejects(app.ctx.tools.run('grep', { pattern: 'x', include: '  ' }), /include must be a non-empty glob/)
  await assert.rejects(app.ctx.tools.run('grep', { pattern: 'x', include: '!*.ts' }), /positive glob/)
  await assert.rejects(app.ctx.tools.run('grep', { pattern: 'x', include: '*.ts,*.js' }), /one glob/)
})

test('search bounds results and ignores external ripgrep configuration', async (t) => {
  const { dir, app } = await setup(t)
  await mkdir(join(dir, 'many'))
  await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(dir, 'many', `${index}.txt`), 'text')))
  const long = `hit${'a'.repeat(1996)}é`
  await writeFile(join(dir, 'matches.txt'), [long, ...Array(250).fill('hit')].join('\n'))
  const config = join(dir, 'rg.conf')
  await writeFile(config, '--glob=*.never\n')
  const prior = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = config
  t.after(() => {
    if (prior === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = prior
  })

  const paths = await app.ctx.tools.run('glob', { pattern: '*.txt', path: 'many' })
  assert.match(paths, /Showing 100 of 101 paths/)
  const matches = await app.ctx.tools.run('grep', { pattern: '^hit', path: 'matches.txt' })
  assert.match(matches, /^Found 250 of 251 matches/)
  assert.match(matches, /\(line truncated\)/)
  assert.doesNotMatch(matches, /�/)
  assert.doesNotMatch(matches, /Line 251:/)
})
