import { isAbsolute } from 'node:path'

export const inject = ['miniSkillRoots']

export function apply(ctx, config) {
  if (!isAbsolute(config?.bundledSkillDir ?? '')) throw new Error('Skill root must be an absolute path')
  ctx.effect(() => ctx.miniSkillRoots.add(config.bundledSkillDir))
}
