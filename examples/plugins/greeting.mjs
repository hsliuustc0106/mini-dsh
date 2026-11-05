export default {
  inject: ['tools', 'permissions'],
  settings: {
    prefix: { type: 'string', description: 'Greeting prefix' },
  },
  apply(ctx, config = {}) {
    ctx.effect(() => ctx.tools.register({
      name: 'greet',
      description: 'Greet someone by name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      execute: ({ name }) => `${config.prefix ?? 'Hello'}, ${name}!`,
    }))
    ctx.effect(() => ctx.permissions.register('greet', 'allow'))
  },
}
