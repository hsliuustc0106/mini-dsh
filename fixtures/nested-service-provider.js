import { Service } from '@deepseek-ai/cordis'

class NestedService extends Service {
  constructor(ctx) { super(ctx, 'nestedFixture') }
}

export function apply(ctx, config) {
  const scope = config.isolated ? ctx.isolate('nestedFixture') : ctx
  scope.plugin(NestedService)
}
