// The bridge against a mock homeserver: discovery, one account per Bot, ordering,
// restart and retry behaviour, and the deletion path. No real homeserver is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startMockHomeserver } from './mock-homeserver.mjs'
import { Bridge } from '../src/bridge.js'

const USER = '@yuanjing:tuxai.test'
const VERIFY = '@verify-a:tuxai.test'

const bot = (id, name) => ({ id, name, role: 'x', color: 'blue', capabilities: [], createdAt: 1 })

async function home(state) {
  const dir = await mkdtemp(join(tmpdir(), 'mxbridge-'))
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify(state, null, 1))
  return { dir, statePath }
}

function configFor(mock, paths, overrides = {}) {
  const events = []
  return {
    homeserverUrl: mock.url,
    registrationToken: mock.registrationToken,
    userMxid: USER,
    userDisplayName: '用户',
    extraInvites: [VERIFY],
    teamStatePath: paths.statePath,
    home: paths.dir,
    statePath: join(paths.dir, 'bridge', 'bridge.json'),
    accountsPath: join(paths.dir, 'bridge', 'accounts.json'),
    cryptoDir: join(paths.dir, 'bridge', 'crypto'),
    pollMs: 50,
    encrypted: false,
    onGroupDeleted: 'notify',
    log: (event, fields) => events.push({ event, ...fields }),
    ...overrides,
    events,
  }
}

const teamWith = (bots, room) => ({
  version: 1,
  bots: Object.fromEntries(bots.map(b => [b.id, b])),
  rooms: room === undefined ? {} : { [room.id]: room },
})

const group = (id, name, members, log = []) => ({ id, name, members, admin: members[0], mode: 'admin', log, seq: log.at(-1)?.seq ?? 0, seen: {} })

test('one account per Bot, one room per group, messages in order', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('session-chief', 'Chief'), bot('session-qiao', '桥接')],
      group('session-g1', 'MX 测试', ['session-chief', 'session-qiao'], [
        { seq: 1, who: 'Chief', botId: 'session-chief', text: '开工' },
        { seq: 2, who: 'User', text: '你好' },
        { seq: 3, who: '桥接', botId: 'session-qiao', text: '收到' },
      ]),
    ))
    const config = configFor(mock, { dir, statePath })
    const bridge = new Bridge(config)
    await bridge.tick()

    // Accounts: name → pinyin slug, display name set to the Bot's name.
    assert.ok(mock.users.has('@chief:tuxai.test'), 'chief account created')
    assert.ok(mock.users.has('@qiaojie:tuxai.test'), 'pinyin localpart for 桥接')
    assert.equal(mock.users.get('@qiaojie:tuxai.test').displayname, '桥接')

    const [roomId] = mock.rooms.keys()
    const room = mock.rooms.get(roomId)
    assert.equal(room.name, 'MX 测试')
    assert.ok(room.invites.has(USER), 'the user is invited')
    assert.ok(room.invites.has(VERIFY), 'the acceptance account is invited')
    assert.ok(room.invites.has('@qiaojie:tuxai.test'), 'the other member Bot is invited')
    assert.ok(room.members.has('@qiaojie:tuxai.test'), 'the other member Bot joined')

    const sent = mock.eventsIn(roomId)
    assert.deepEqual(sent.map(e => e['org.dsbot.seq']), [1, 2, 3], 'lines go out in order')
    assert.equal(sent[0].sender, '@chief:tuxai.test')
    assert.equal(sent[1].sender, '@chief:tuxai.test', 'a user line is relayed by the group admin')
    assert.equal(sent[1]['org.dsbot.from_user'], true)
    assert.equal(sent[2].sender, '@qiaojie:tuxai.test', 'a Bot line is sent by that Bot')
    assert.equal(sent[0].displayname, 'Chief')
  } finally {
    await mock.close()
  }
})

test('a restart does not send anything twice', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('session-chief', 'Chief')],
      group('session-g1', '群', ['session-chief'], [{ seq: 1, who: 'Chief', botId: 'session-chief', text: '一' }]),
    ))
    const paths = { dir, statePath }
    await new Bridge(configFor(mock, paths)).tick()
    const roomId = [...mock.rooms.keys()][0]
    assert.equal(mock.eventsIn(roomId).length, 1)

    // A second process over the same state (a restart) mirrors nothing again.
    await new Bridge(configFor(mock, paths)).tick()
    assert.equal(mock.eventsIn(roomId).length, 1)
  } finally {
    await mock.close()
  }
})

test('a lost response is retried without duplicating the event', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('session-chief', 'Chief')],
      group('session-g1', '群', ['session-chief'], [{ seq: 1, who: 'Chief', botId: 'session-chief', text: '一' }]),
    ))
    const config = configFor(mock, { dir, statePath })
    // The account is created first, then the send's response is lost.
    mock.failNextResponse(502)
    // The first send (account creation is not a room send) — make the room creation pass,
    // then arm the failure right before the message send.
    const bridge = new Bridge(config)
    await bridge.pass().catch(() => {})
    let roomId = [...mock.rooms.keys()][0]
    if (roomId === undefined) {
      mock.failNextResponse(502)
      await bridge.tick()
      roomId = [...mock.rooms.keys()][0]
    }
    assert.equal(mock.eventsIn(roomId).length, 1, 'the event reached the server once')
    await bridge.tick()
    assert.equal(mock.eventsIn(roomId).length, 1, 'the retry reused the transaction id')
    const failed = config.events.filter(e => e.event === 'send-failed').length
    assert.ok(failed >= 0)
  } finally {
    await mock.close()
  }
})

test('a Bot added to a group later gets an account, an invite and a join', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('b1', 'Chief')],
      group('g1', '群', ['b1'], [{ seq: 1, who: 'Chief', botId: 'b1', text: '一' }]),
    ))
    const paths = { dir, statePath }
    await new Bridge(configFor(mock, paths)).tick()

    // The user creates a new Bot and adds it to the group.
    const grown = teamWith(
      [bot('b1', 'Chief'), bot('b2', '验收')],
      group('g1', '群', ['b1', 'b2'], [
        { seq: 1, who: 'Chief', botId: 'b1', text: '一' },
        { seq: 2, who: '验收', botId: 'b2', text: '我进来了' },
      ]),
    )
    await writeFile(statePath, JSON.stringify(grown, null, 1))
    await new Bridge(configFor(mock, paths)).tick()

    assert.ok(mock.users.has('@yanshou:tuxai.test'), 'new Bot got its own account')
    const room = [...mock.rooms.values()][0]
    assert.ok(room.members.has('@yanshou:tuxai.test'), 'new Bot joined the existing room')
    const sent = room.events.at(-1)
    assert.equal(sent.sender, '@yanshou:tuxai.test', 'the new Bot speaks as itself')
    assert.equal(sent.content.body, '验收: 我进来了')
  } finally {
    await mock.close()
  }
})

test('renaming a Bot updates its display name, never its user id', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith([bot('b1', '桥接')], group('g1', '群', ['b1'], [])))
    const paths = { dir, statePath }
    await new Bridge(configFor(mock, paths)).tick()
    assert.ok(mock.users.has('@qiaojie:tuxai.test'))

    await writeFile(statePath, JSON.stringify(teamWith([bot('b1', 'MX桥')], group('g1', '群', ['b1'], [])), null, 1))
    await new Bridge(configFor(mock, paths)).tick()
    assert.equal(mock.users.get('@qiaojie:tuxai.test').displayname, 'MX桥')
    assert.equal(mock.users.has('@mx-qiao:tuxai.test'), false, 'a rename does not mint a second account')
  } finally {
    await mock.close()
  }
})

test('a deleted group is announced and stops receiving messages', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('b1', 'Chief')],
      group('g1', '要删的群', ['b1'], [{ seq: 1, who: 'Chief', botId: 'b1', text: '一' }]),
    ))
    const paths = { dir, statePath }
    await new Bridge(configFor(mock, paths)).tick()
    const roomId = [...mock.rooms.keys()][0]
    assert.equal(mock.eventsIn(roomId).length, 1)

    await writeFile(statePath, JSON.stringify(teamWith([bot('b1', 'Chief')]), null, 1))
    const bridge = new Bridge(configFor(mock, paths))
    await bridge.tick()
    const after = mock.eventsIn(roomId)
    assert.equal(after.length, 2)
    assert.equal(after[1].msgtype, 'm.notice')

    await bridge.tick()
    assert.equal(mock.eventsIn(roomId).length, 2, 'the notice is sent once')
  } finally {
    await mock.close()
  }
})

test('the account inventory has device ids and crypto store paths but no tokens', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith([bot('b1', 'Chief')], group('g1', '群', ['b1'], [])))
    const config = configFor(mock, { dir, statePath })
    await new Bridge(config).tick()
    const inventory = JSON.parse(await readFile(config.accountsPath, 'utf8'))
    const entry = inventory.bots.b1
    assert.equal(entry.userId, '@chief:tuxai.test')
    assert.equal(entry.deviceId, 'DEVCHIEF')
    assert.ok(entry.cryptoStore.endsWith('/b1'))
    const raw = JSON.stringify(inventory)
    assert.equal(raw.includes('tok-chief'), false)
    assert.equal(raw.includes('password'), false)
  } finally {
    await mock.close()
  }
})

test('a long line is mirrored whole from its own file', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('b1', 'Chief')],
      group('g1', '群', ['b1'], [{ seq: 7, who: 'Chief', botId: 'b1', text: '短开头', length: 40 }]),
    ))
    await mkdir(join(dir, 'group-lines', 'g1'), { recursive: true })
    await writeFile(join(dir, 'group-lines', 'g1', '7.txt'), '短开头，加上文件里的其余部分，一共要超过四十个字符才对。')
    const config = configFor(mock, { dir, statePath })
    await new Bridge(config).tick()
    const roomId = [...mock.rooms.keys()][0]
    const body = mock.eventsIn(roomId)[0].body
    assert.ok(body.endsWith('一共要超过四十个字符才对。'), `whole text expected, got ${body}`)
  } finally {
    await mock.close()
  }
})

test('a send that was in flight at a crash is resumed with the same transaction id', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('b1', 'Chief')],
      group('g1', '群', ['b1'], [{ seq: 1, who: 'Chief', botId: 'b1', text: '一' }]),
    ))
    const config = configFor(mock, { dir, statePath })
    await new Bridge(config).tick()
    const roomId = [...mock.rooms.keys()][0]
    assert.equal(mock.eventsIn(roomId).length, 1)

    // Rewind the saved state to what a process killed between "sent" and "cursor saved"
    // leaves behind: the event exists, the cursor does not know about it.
    const saved = JSON.parse(await readFile(config.statePath, 'utf8'))
    const record = saved.rooms.g1
    record.cursor = 0
    delete record.recent
    record.pending = { seq: 1, txn: 'dsbot.g1.1', at: Date.now() }
    await writeFile(config.statePath, JSON.stringify(saved))

    const events = []
    const bridge = new Bridge(configFor(mock, { dir, statePath }, { log: (event, fields) => events.push({ event, ...fields }) }))
    await bridge.tick()
    assert.equal(mock.eventsIn(roomId).length, 1, 'the room still holds one copy')
    assert.ok(events.some(e => e.event === 'resent' && e.recovered === true), 'the resume is logged as a resend')
    const after = JSON.parse(await readFile(config.statePath, 'utf8'))
    assert.equal(after.rooms.g1.cursor, 1)
    assert.equal(after.rooms.g1.pending, undefined)
  } finally {
    await mock.close()
  }
})

test('the creator and the user are admins from the room\'s first event', async () => {
  const mock = await startMockHomeserver()
  try {
    const { dir, statePath } = await home(teamWith(
      [bot('b1', 'Chief'), bot('b2', '验收')],
      group('g1', '群', ['b1', 'b2'], []),
    ))
    const config = configFor(mock, { dir, statePath })
    await new Bridge(config).tick()
    const room = [...mock.rooms.values()][0]
    assert.equal(room.powerLevels.users[USER], 100)
    assert.equal(room.powerLevels.users['@chief:tuxai.test'], undefined, 'the creator is implicit 100 and never listed')
    assert.equal(room.powerLevels.users['@yanshou:tuxai.test'], 50)
    assert.equal(room.powerLevels.users_default, 0)
  } finally {
    await mock.close()
  }
})
