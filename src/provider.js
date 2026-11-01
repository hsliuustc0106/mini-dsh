// A prepared provider for tests and this slice. The live DeepSeek provider
// is a later slice. prepare() returns the JSON body; dispatch() sends it once.

export function fakeProvider(replies = []) {
  const queue = [...replies]
  const sent = []
  const plugin = {
    inject: ['model'],
    apply(ctx) {
      ctx.effect(() => ctx.model.register({
        name: 'fake',
        prepare(input) {
          return {
            model: 'fake',
            instructions: input.instructions,
            context: input.context,
            messages: input.messages,
            tools: input.tools,
          }
        },
        dispatch(body) {
          sent.push(structuredClone(body))
          if (!queue.length) throw new Error('Fake provider has no prepared reply')
          const reply = queue.shift()
          return typeof reply === 'function' ? reply(body) : reply
        },
      }))
    },
  }
  plugin.sent = sent
  return plugin
}
