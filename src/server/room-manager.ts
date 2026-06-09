import { PLAYER_PRESETS } from '../lib/game-engine'

export interface RoomPlayer {
  socketId: string
  name: string
  avatar: string
  color: string
  ready: boolean
  index: number
}

export interface RoomSettings {
  maxPlayers: number
  initialMoney: number
  maxRounds: number
}

export interface Room {
  code: string
  host: string
  players: Map<string, RoomPlayer>
  settings: RoomSettings
  inGame: boolean
  lastActivity: number
}

const rooms = new Map<string, Room>()
const socketToRoom = new Map<string, string>()

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code: string
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  } while (rooms.has(code))
  return code
}

export function createRoom(socketId: string, name: string, settings?: Partial<RoomSettings>): Room {
  const code = generateCode()
  const room: Room = {
    code,
    host: socketId,
    players: new Map(),
    settings: {
      maxPlayers: settings?.maxPlayers || 4,
      initialMoney: settings?.initialMoney || 1500,
      maxRounds: settings?.maxRounds || 30,
    },
    inGame: false,
    lastActivity: Date.now(),
  }

  const preset = PLAYER_PRESETS[0]
  room.players.set(socketId, {
    socketId, name,
    avatar: preset.avatar, color: preset.color,
    ready: false, index: 0,
  })

  rooms.set(code, room)
  socketToRoom.set(socketId, code)
  return room
}

export function joinRoom(code: string, socketId: string, name: string): { success: boolean; room?: Room; error?: string } {
  const room = rooms.get(code.toUpperCase())
  if (!room) return { success: false, error: '房间不存在' }
  if (room.inGame) return { success: false, error: '游戏已开始' }
  if (room.players.size >= room.settings.maxPlayers) return { success: false, error: '房间已满' }

  const idx = room.players.size
  const preset = PLAYER_PRESETS[idx % PLAYER_PRESETS.length]
  room.players.set(socketId, {
    socketId, name,
    avatar: preset.avatar, color: preset.color,
    ready: false, index: idx,
  })

  socketToRoom.set(socketId, code)
  room.lastActivity = Date.now()
  return { success: true, room }
}

export function leaveRoom(socketId: string): { room?: Room; dissolved: boolean } {
  const code = socketToRoom.get(socketId)
  if (!code) return { dissolved: false }

  const room = rooms.get(code)
  if (!room) { socketToRoom.delete(socketId); return { dissolved: false } }

  room.players.delete(socketId)
  socketToRoom.delete(socketId)

  if (room.players.size === 0) {
    rooms.delete(code)
    return { dissolved: true }
  }

  if (room.host === socketId) {
    room.host = room.players.keys().next().value!
  }

  // 重新分配索引
  let i = 0
  for (const [, p] of room.players) { p.index = i++ }

  room.lastActivity = Date.now()
  return { room, dissolved: false }
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase())
}

export function getRoomBySocket(socketId: string): Room | undefined {
  const code = socketToRoom.get(socketId)
  return code ? rooms.get(code) : undefined
}

export function setReady(socketId: string, ready: boolean): Room | undefined {
  const room = getRoomBySocket(socketId)
  if (!room) return
  const player = room.players.get(socketId)
  if (player) player.ready = ready
  room.lastActivity = Date.now()
  return room
}

export function allReady(room: Room): boolean {
  if (room.players.size < 2) return false
  for (const [, p] of room.players) {
    if (!p.ready) return false
  }
  return true
}

export function serializeRoom(room: Room) {
  return {
    code: room.code,
    host: room.host,
    players: Array.from(room.players.values()),
    settings: room.settings,
    inGame: room.inGame,
  }
}

// 定期清理闲置房间（5分钟）
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (!room.inGame && now - room.lastActivity > 5 * 60 * 1000) {
      for (const sid of room.players.keys()) socketToRoom.delete(sid)
      rooms.delete(code)
    }
  }
}, 60 * 1000)
