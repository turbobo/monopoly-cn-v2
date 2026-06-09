'use client'

import { useState, useEffect, useCallback } from 'react'
import { connectSocket, disconnectSocket } from '@/lib/socket'
import Game from '@/components/Game'
import type { GameState } from '@/lib/game-engine'

type Screen = 'lobby' | 'room' | 'game'

interface RoomData {
  code: string
  host: string
  players: { socketId: string; name: string; avatar: string; color: string; ready: boolean; index: number }[]
  settings: { maxPlayers: number; initialMoney: number; maxRounds: number }
  inGame: boolean
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>('lobby')
  const [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [room, setRoom] = useState<RoomData | null>(null)
  const [game, setGame] = useState<GameState | null>(null)
  const [myIndex, setMyIndex] = useState(-1)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState({ maxPlayers: 4, initialMoney: 1500 })

  useEffect(() => {
    return () => disconnectSocket()
  }, [])

  const handleCreate = useCallback(() => {
    if (!nickname.trim()) { setError('请输入昵称'); return }
    setError('')
    const socket = connectSocket()

    socket.emit('create-room', { name: nickname.trim(), settings }, (res: any) => {
      if (res.success) {
        setRoom(res.room)
        setScreen('room')
      } else {
        setError(res.error || '创建失败')
      }
    })

    socket.on('room-update', (data: RoomData) => setRoom(data))
  }, [nickname, settings])

  const handleJoin = useCallback(() => {
    if (!nickname.trim()) { setError('请输入昵称'); return }
    if (!roomCode.trim()) { setError('请输入房间码'); return }
    setError('')
    const socket = connectSocket()

    socket.emit('join-room', { code: roomCode.trim().toUpperCase(), name: nickname.trim() }, (res: any) => {
      if (res.success) {
        setRoom(res.room)
        setScreen('room')
      } else {
        setError(res.error || '加入失败')
      }
    })

    socket.on('room-update', (data: RoomData) => setRoom(data))
  }, [nickname, roomCode])

  const handleReady = useCallback(() => {
    const socket = connectSocket()
    socket.emit('toggle-ready')
  }, [])

  const handleStart = useCallback(() => {
    const socket = connectSocket()
    socket.emit('start-game')
  }, [])

  const handleLeave = useCallback(() => {
    const socket = connectSocket()
    socket.emit('leave-room')
    setRoom(null)
    setScreen('lobby')
  }, [])

  // 监听游戏开始
  useEffect(() => {
    const socket = connectSocket()
    const onGameStart = (gs: GameState) => {
      setGame(gs)
      if (room) {
        const idx = room.players.findIndex(p => p.socketId === socket.id)
        setMyIndex(idx)
      }
      setScreen('game')
    }
    socket.on('game-start', onGameStart)
    return () => { socket.off('game-start', onGameStart) }
  }, [room])

  if (screen === 'game' && game) {
    return <Game initialGame={game} myIndex={myIndex} onExit={() => { setScreen('lobby'); setRoom(null); setGame(null) }} />
  }

  const socketId = typeof window !== 'undefined' ? connectSocket().id : ''
  const isHost = room?.host === socketId
  const allReady = room ? room.players.length >= 2 && room.players.every(p => p.ready) : false

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#0f1419]">
      {screen === 'lobby' && (
        <div className="w-full max-w-md mx-4 fade-in">
          <div className="text-center mb-10">
            <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-400 to-red-400 mb-2">
              大富翁
            </h1>
            <p className="text-xl text-orange-300 font-medium">中国行 · 在线对战</p>
          </div>

          <div className="bg-[#1a2332] rounded-2xl p-6 border border-white/10 space-y-4">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">你的昵称</label>
              <input value={nickname} onChange={e => setNickname(e.target.value)}
                placeholder="输入昵称..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
                maxLength={8} />
            </div>

            {error && <div className="text-red-400 text-sm text-center">{error}</div>}

            {!creating ? (
              <div className="space-y-3">
                <button onClick={() => setCreating(true)}
                  className="w-full py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all text-lg">
                  创建房间
                </button>
                <div className="flex gap-2">
                  <input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())}
                    placeholder="输入房间码"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-center tracking-widest font-bold focus:outline-none focus:border-orange-500/50"
                    maxLength={4} />
                  <button onClick={handleJoin}
                    className="px-6 py-3 bg-blue-600 rounded-xl text-white font-bold hover:bg-blue-500 transition-colors">
                    加入
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-gray-400 text-sm mb-2 block">最大人数</label>
                  <div className="flex gap-2">
                    {[2, 3, 4].map(n => (
                      <button key={n} onClick={() => setSettings(s => ({ ...s, maxPlayers: n }))}
                        className={`flex-1 py-2.5 rounded-xl font-medium transition-all ${settings.maxPlayers === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                        {n}人
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-2 block">初始资金</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[800, 1000, 1500, 2000].map(n => (
                      <button key={n} onClick={() => setSettings(s => ({ ...s, initialMoney: n }))}
                        className={`py-2 rounded-xl text-sm font-medium transition-all ${settings.initialMoney === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                        ¥{n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setCreating(false)}
                    className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400">
                    返回
                  </button>
                  <button onClick={handleCreate}
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold">
                    确认创建
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {screen === 'room' && room && (
        <div className="w-full max-w-md mx-4 fade-in">
          <div className="bg-[#1a2332] rounded-2xl p-6 border border-white/10">
            <div className="text-center mb-6">
              <div className="text-gray-400 text-sm">房间码</div>
              <div className="text-4xl font-black text-amber-400 tracking-[0.3em] my-2">{room.code}</div>
              <div className="text-gray-500 text-xs">分享房间码给好友，邀请他们加入</div>
            </div>

            <div className="space-y-2 mb-6">
              <div className="text-gray-400 text-sm mb-2">玩家 ({room.players.length}/{room.settings.maxPlayers})</div>
              {room.players.map((p, i) => (
                <div key={p.socketId}
                  className="flex items-center justify-between p-3 rounded-xl"
                  style={{ background: p.color + '15', border: `1px solid ${p.color}33` }}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{p.avatar}</span>
                    <div>
                      <span className="text-white font-medium">{p.name}</span>
                      {p.socketId === room.host && <span className="text-xs text-amber-400 ml-2">房主</span>}
                    </div>
                  </div>
                  <span className={`text-xs px-3 py-1 rounded-full font-bold ${p.ready ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-gray-500'}`}>
                    {p.ready ? '已准备' : '未准备'}
                  </span>
                </div>
              ))}
              {Array.from({ length: room.settings.maxPlayers - room.players.length }).map((_, i) => (
                <div key={`empty-${i}`} className="p-3 rounded-xl bg-white/3 border border-dashed border-white/10 text-center text-gray-600 text-sm">
                  等待加入...
                </div>
              ))}
            </div>

            <div className="text-xs text-gray-500 text-center mb-4">
              初始资金 ¥{room.settings.initialMoney} · 最多 {room.settings.maxRounds} 回合
            </div>

            <div className="space-y-2">
              <div className="flex gap-2">
                <button onClick={handleLeave}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                  离开
                </button>
                <button onClick={handleReady}
                  className={`flex-[2] py-3 rounded-xl font-bold transition-all ${room.players.find(p => p.socketId === socketId)?.ready
                    ? 'bg-green-600 text-white hover:bg-green-500'
                    : 'bg-blue-600 text-white hover:bg-blue-500'}`}>
                  {room.players.find(p => p.socketId === socketId)?.ready ? '取消准备' : '准备'}
                </button>
              </div>
              {isHost && (
                <button onClick={handleStart} disabled={!allReady}
                  className="w-full py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                  {allReady ? '开始游戏！' : '等待所有人准备...'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
