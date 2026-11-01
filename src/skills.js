import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const skillGesture = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
const absent = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

async function projectRoot(workspace) {
  let current = resolve(workspace)
  for (;;) {
    try { await access(join(current, '.git')); return current }
    catch (error) { if (!absent(error)) throw error }
    const parent = dirname(current)
    if (parent === current) return resolve(workspace)
    current = parent
  }
}

function homePath(value, fallback, home) {
  const selected = typeof value === 'string' && value.trim() ? value : fallback
  if (selected === '~') return resolve(home)
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(home, selected.slice(2))
  return resolve(selected)
}

async function roots(workspace, options) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const project = await projectRoot(workspace)
  const dshHome = homePath(env.DSH_HOME, join(home, '.dsh'), home)
  const agentsHome = homePath(env.DSH_AGENTS_HOME, join(home, '.agents'), home)
  return [
    { path: join(project, '.dsh', 'skills') },
    { path: join(project, '.agents', 'skills') },
    ...(options.customSkillDirs ?? []).map((path) => ({ path: resolve(path) })),
    { path: join(dshHome, 'skills'), skipSystem: true },
    { path: join(agentsHome, 'skills') },
    ...(env.DSH_BUNDLED_SKILL_DIR === undefined ? [] : [{ path: resolve(env.DSH_BUNDLED_SKILL_DIR) }]),
  ]
}

function booleanField(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new Error(`${key} must be a boolean`)
}

function parseSkill(raw, path) {
  const match = /^---\r?\n([\s\S]*?)^---\r?(?:\n|$)/m.exec(raw)
  if (!match || match.index !== 0) throw new Error('missing YAML frontmatter')
  const data = parseYaml(match[1])
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid YAML frontmatter')
  if (typeof data.name !== 'string' || !skillName.test(data.name)) throw new Error('invalid skill name')
  if (typeof data.description !== 'string' || !data.description.length) throw new Error('missing description')
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, key)) throw new Error(`unsupported field ${key}`)
  }
  const modelInvocable = booleanField(data, 'disable-model-invocation') !== true
  const userInvocable = booleanField(data, 'user-invocable') !== false
  return { name: data.name, description: data.description, modelInvocable, userInvocable, path, content: raw.slice(match[0].length).trim() }
}

// Roots are rescanned for each request. A name from an earlier root wins even
// when that skill is not model-invocable.
export async function discoverSkills(workspace, options = {}, warn = () => {}) {
  const found = new Map()
  let complete = true
  for (const root of await roots(workspace, options)) {
    let entries
    try { entries = await readdir(root.path, { withFileTypes: true }) }
    catch (error) {
      if (!absent(error)) { complete = false; warn(`skill root ${root.path}: ${error.message}`) }
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (root.skipSystem && entry.name === '.system') continue
      const entryPath = join(root.path, entry.name)
      let kind = entry
      if (entry.isSymbolicLink()) {
        try { kind = await stat(entryPath) }
        catch (error) {
          if (!absent(error)) { complete = false; warn(`skill entry ${entryPath}: ${error.message}`) }
          continue
        }
      }
      const path = kind.isDirectory() ? join(entryPath, 'SKILL.md')
        : kind.isFile() && entry.name.endsWith('.md') ? entryPath : undefined
      if (!path) continue
      let raw
      try { raw = await readFile(path, 'utf8') }
      catch (error) {
        if (!absent(error)) { complete = false; warn(`skill file ${path}: ${error.message}`) }
        continue
      }
      let skill
      try { skill = parseSkill(raw, path) }
      catch (error) { warn(`skill file ${path} ignored: ${error.message}`); continue }
      if (!found.has(skill.name)) found.set(skill.name, skill)
    }
  }
  return { skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), complete }
}

function catalog({ skills, complete }) {
  const available = skills.filter((skill) => skill.modelInvocable).map(({ name, description }) => ({
    name, description: description.replace(/\s+/g, ' ').trim().slice(0, 500),
  }))
  if (!available.length && complete) return undefined
  return [
    'Skills are reusable task instructions. Available skills (names and descriptions only):',
    JSON.stringify(available),
    ...(!complete ? ['Some skill sources could not be checked; discovery will be retried on the next request.'] : []),
    'When a skill matches the task or the user names it, call the skill tool with its exact name before acting. Follow the loaded instructions, not the summary alone. If the user explicitly invoked a skill and its instructions are already present, do not load it again.',
  ].join('\n')
}

function renderSkill(skill) {
  return [
    `<skill_content name="${skill.name}">`,
    `Base directory for this skill: ${dirname(skill.path)}`,
    'Resolve relative paths against this directory. Load referenced resources only as needed.',
    '', skill.content, '</skill_content>',
  ].join('\n')
}

export const skills = {
  inject: ['workspace', 'prompt', 'tools'],
  apply(ctx, options = {}) {
    const discover = () => discoverSkills(ctx.workspace.root, options, (message) => ctx.logger.warn(message))
    ctx.effect(() => ctx.prompt.contribute({
      order: 10,
      instructions: async () => catalog(await discover()),
      async onUserInput(input) {
        const names = [...new Set([...input.matchAll(skillGesture)].map((match) => match[2]))]
        if (!names.length) return []
        const available = (await discover()).skills
        return names.flatMap((name) => {
          const skill = available.find((item) => item.name === name && item.userInvocable)
          if (!skill) return []
          return [{ name, content: `The user explicitly invoked this skill. Follow its instructions; do not load it again.\n${renderSkill(skill)}` }]
        })
      },
    }))
    ctx.effect(() => ctx.tools.register({
      name: 'skill',
      description: 'Load the full instructions for an available skill by its exact name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      async execute({ name }) {
        if (!skillName.test(name)) throw new Error(`Invalid skill name: ${name}`)
        const skill = (await discover()).skills.find((item) => item.name === name)
        if (!skill || !skill.modelInvocable) throw new Error(`Skill is not available: ${name}`)
        return renderSkill(skill)
      },
    }))
  },
}
