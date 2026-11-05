// Compatible DSH client UI plugin. mini-dsh loads this file as written.
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'review',
    order: 100,
  }, function HeaderAction() {
    return { type: 'button', props: { type: 'button', children: 'Review' } }
  }))
}
