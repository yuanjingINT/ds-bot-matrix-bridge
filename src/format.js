// What a group line looks like on the Matrix side.
//
// With one account per Bot the sender is the Bot itself; the display name and the body's
// prefix are still filled in, so the line stays readable in clients that show member
// state and in plain-text notifications.
const MAX_BODY = 60_000

const whoOf = (line, config) => (line.botId === undefined
  ? config.userDisplayName ?? line.who ?? 'User'
  : line.who ?? 'Bot')

export function renderLine({ room, line, text, config }) {
  const who = whoOf(line, config)
  const fromUser = line.botId === undefined
  // The sender account and its display name already say who wrote it; a "名字：" prefix in
  // the body would show the name twice and corrupt copied text.
  const body = text === '' ? '(empty message)' : text
  return {
    msgtype: 'm.text',
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n… (truncated by the bridge)` : body,
    displayname: who,
    'org.dsbot.room_id': room.id,
    'org.dsbot.room_name': room.name ?? '',
    'org.dsbot.seq': line.seq,
    ...(fromUser
      ? { 'org.dsbot.from_user': true }
      : { 'org.dsbot.bot_id': line.botId }),
  }
}

// The round events the host writes into a group log ("resumed", "stopped", "done", "cut")
// become a notice, so they are visible without pretending to be a message.
export function renderEventLine({ room, line, config }) {
  const who = whoOf(line, config)
  const what = {
    resumed: '继续干活',
    stopped: '被停下',
    done: '汇报完毕',
    cut: '上下文到顶被截断',
  }[line.kind] ?? line.kind
  return {
    msgtype: 'm.notice',
    body: `— ${who} ${what}`,
    displayname: who,
    'org.dsbot.room_id': room.id,
    'org.dsbot.room_name': room.name ?? '',
    'org.dsbot.seq': line.seq,
    'org.dsbot.kind': line.kind,
    ...(line.botId === undefined ? {} : { 'org.dsbot.bot_id': line.botId }),
  }
}
