import { createServer } from 'http'
import next from 'next'
import { Server } from 'socket.io'
import {
  createRoom, joinRoom, leaveRoom, setReady, allReady,
  getRoomBySocket, serializeRoom,
} from './src/server/room-manager'
import { startGame, setupGameEvents } from './src/server/game-handler'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res))
  const io = new Server(httpServer, { cors: { origin: '*' } })

  io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`)

    socket.on('create-room', ({ name, settings }, callback) => {
      const room = createRoom(socket.id, name, settings)
      socket.join(room.code)
      callback({ success: true, room: serializeRoom(room) })
      console.log(`[创建房间] ${room.code} by ${name}`)
    })

    socket.on('join-room', ({ code, name }, callback) => {
      const result = joinRoom(code, socket.id, name)
      if (result.success && result.room) {
        socket.join(result.room.code)
        callback({ success: true, room: serializeRoom(result.room) })
        socket.to(result.room.code).emit('room-update', serializeRoom(result.room))
        console.log(`[加入房间] ${code} by ${name}`)
      } else {
        callback({ success: false, error: result.error })
      }
    })

    socket.on('toggle-ready', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      const player = room.players.get(socket.id)
      if (!player) return
      setReady(socket.id, !player.ready)
      io.to(room.code).emit('room-update', serializeRoom(room))
    })

    socket.on('start-game', () => {
      const room = getRoomBySocket(socket.id)
      if (!room || room.host !== socket.id) return
      if (!allReady(room)) return
      startGame(room, io)
      console.log(`[开始游戏] ${room.code}`)
    })

    socket.on('leave-room', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      const code = room.code
      socket.leave(code)
      const { room: updatedRoom, dissolved } = leaveRoom(socket.id)
      if (!dissolved && updatedRoom) {
        io.to(code).emit('room-update', serializeRoom(updatedRoom))
      }
    })

    setupGameEvents(socket, io)

    socket.on('disconnect', () => {
      console.log(`[断开] ${socket.id}`)
    })
  })

  const PORT = 3460
  httpServer.listen(PORT, () => {
    console.log(`> 大富翁中国行 v2 运行在 http://localhost:${PORT}`)
  })
})
