import { Server, Socket } from 'socket.io'
import { Room, serializeRoom, getRoomBySocket, leaveRoom } from './room-manager'
import {
  GameState, Player, BOARD, BOARD_SIZE, PLAYER_PRESETS,
  rollDice, executeTurn, buyProperty, checkBankrupt, totalWealth,
  auctionDecision,
} from '../lib/game-engine'

const roomGames = new Map<string, GameState>()

export function startGame(room: Room, io: Server) {
  const players: Player[] = []
  let i = 0
  for (const [, rp] of room.players) {
    players.push({
      id: i,
      name: rp.name,
      avatar: rp.avatar,
      money: room.settings.initialMoney,
      position: 0,
      properties: [],
      inJail: false,
      jailTurns: 0,
      bankrupt: false,
      isAI: false,
      color: rp.color,
    })
    i++
  }

  const gs: GameState = {
    players,
    currentPlayer: 0,
    round: 1,
    maxRounds: room.settings.maxRounds,
    dice: [1, 1],
    phase: 'roll',
    log: [],
    gameOver: false,
    winner: null,
    difficulty: 'normal',
  }

  room.inGame = true
  roomGames.set(room.code, gs)

  const socketIds = Array.from(room.players.keys())
  io.to(room.code).emit('game-start', gs)
  io.to(socketIds[gs.currentPlayer]).emit('your-turn')
}

export function setupGameEvents(socket: Socket, io: Server) {
  socket.on('roll', () => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs || gs.gameOver) return

    const socketIds = Array.from(room.players.keys())
    const playerIdx = socketIds.indexOf(socket.id)
    if (playerIdx !== gs.currentPlayer) return
    if (gs.phase !== 'roll') return

    const dice = rollDice()
    const msgs = executeTurn(gs, dice)

    io.to(room.code).emit('game-update', gs, msgs, dice)

    if ((gs.phase as string) === 'action') {
      io.to(socketIds[gs.currentPlayer]).emit('buy-prompt', BOARD[gs.players[gs.currentPlayer].position])
    } else if (!gs.gameOver) {
      io.to(socketIds[gs.currentPlayer]).emit('your-turn')
    } else {
      io.to(room.code).emit('game-over', gs)
      room.inGame = false
      roomGames.delete(room.code)
    }
  })

  socket.on('buy', ({ tileId }: { tileId: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs || gs.phase !== 'action') return

    const socketIds = Array.from(room.players.keys())
    const playerIdx = socketIds.indexOf(socket.id)
    if (playerIdx !== gs.currentPlayer) return

    const player = gs.players[gs.currentPlayer]
    const msgs: string[] = []

    buyProperty(player, tileId)
    msgs.push(`🏠 ${player.name} 购买了 ${BOARD[tileId].name}（¥${BOARD[tileId].price}）`)

    const br = checkBankrupt(player)
    for (const id of br.soldTiles) {
      msgs.push(`🏷️ ${player.name} 被迫卖出了 ${BOARD[id].name}（6折 ¥${Math.floor(BOARD[id].price * 0.6)}）`)
    }
    if (br.bankrupt) msgs.push(`💀 ${player.name} 破产了！`)

    advancePlayer(gs, room, io, msgs, socketIds)
  })

  socket.on('skip', () => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs || gs.phase !== 'action') return

    const socketIds = Array.from(room.players.keys())
    const playerIdx = socketIds.indexOf(socket.id)
    if (playerIdx !== gs.currentPlayer) return

    const player = gs.players[gs.currentPlayer]
    const tile = BOARD[player.position]
    const msgs = [`❌ ${player.name} 放弃购买 ${tile.name}`]

    // 拍卖
    const otherActive = gs.players.filter((p, i) => i !== gs.currentPlayer && !p.bankrupt)
    if (otherActive.length > 0) {
      let currentBid = Math.floor(tile.price * 0.5)
      let winnerId: number | null = null
      // 在线模式：直接进入玩家拍卖 UI
      gs.phase = 'auction'
      io.to(room.code).emit('auction-start', {
        tile,
        startBid: currentBid,
        passedPlayers: [gs.currentPlayer],
      })
      io.to(room.code).emit('game-update', gs, msgs, null)
      return
    }

    advancePlayer(gs, room, io, msgs, socketIds)
  })

  socket.on('auction-bid', ({ amount }: { amount: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs || gs.phase !== 'auction') return

    const socketIds = Array.from(room.players.keys())
    const playerIdx = socketIds.indexOf(socket.id)
    const player = gs.players[playerIdx]
    if (!player || player.bankrupt || amount > player.money) return

    io.to(room.code).emit('auction-update', { bidderId: playerIdx, amount })
  })

  socket.on('auction-end', ({ winnerId, amount, tileId }: { winnerId: number | null; amount: number; tileId: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs || gs.phase !== 'auction') return

    const socketIds = Array.from(room.players.keys())
    const msgs: string[] = []

    if (winnerId !== null) {
      const winner = gs.players[winnerId]
      winner.money -= amount
      winner.properties.push(tileId)
      msgs.push(`🔨 ${winner.name} 以 ¥${amount} 拍得 ${BOARD[tileId].name}！`)
    } else {
      msgs.push(`🔨 无人竞拍 ${BOARD[tileId].name}，流拍`)
    }

    advancePlayer(gs, room, io, msgs, socketIds)
  })

  socket.on('sell-property', ({ tileId }: { tileId: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs) return

    const socketIds = Array.from(room.players.keys())
    const playerIdx = socketIds.indexOf(socket.id)
    if (playerIdx !== gs.currentPlayer) return

    const player = gs.players[playerIdx]
    if (!player.properties.includes(tileId)) return

    const tile = BOARD[tileId]
    const sellPrice = Math.floor(tile.price * 0.6)
    player.money += sellPrice
    player.properties = player.properties.filter(id => id !== tileId)

    const msgs = [`🏷️ ${player.name} 变卖了 ${tile.name}（¥${sellPrice}）`]
    io.to(room.code).emit('game-update', gs, msgs, null)
  })

  socket.on('trade-offer', ({ targetIdx, tileId, offer }: { targetIdx: number; tileId: number; offer: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs) return

    const socketIds = Array.from(room.players.keys())
    const buyerIdx = socketIds.indexOf(socket.id)
    if (buyerIdx !== gs.currentPlayer) return

    const targetSocket = socketIds[targetIdx]
    if (!targetSocket) return

    io.to(targetSocket).emit('trade-request', {
      fromIdx: buyerIdx,
      fromName: gs.players[buyerIdx].name,
      tileId,
      tileName: BOARD[tileId].name,
      offer,
    })
  })

  socket.on('trade-response', ({ accepted, fromIdx, tileId, offer }: { accepted: boolean; fromIdx: number; tileId: number; offer: number }) => {
    const room = getRoomBySocket(socket.id)
    if (!room) return
    const gs = roomGames.get(room.code)
    if (!gs) return

    const socketIds = Array.from(room.players.keys())
    const sellerIdx = socketIds.indexOf(socket.id)
    const buyer = gs.players[fromIdx]
    const seller = gs.players[sellerIdx]
    const msgs: string[] = []

    if (accepted) {
      buyer.money -= offer
      seller.money += offer
      seller.properties = seller.properties.filter(id => id !== tileId)
      buyer.properties.push(tileId)
      msgs.push(`🤝 ${buyer.name} 以 ¥${offer} 从 ${seller.name} 购得 ${BOARD[tileId].name}`)
    } else {
      msgs.push(`🚫 ${seller.name} 拒绝了 ${buyer.name} 的交易请求`)
    }

    io.to(room.code).emit('game-update', gs, msgs, null)
  })

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket.id)
    if (room) {
      const gs = roomGames.get(room.code)
      if (gs && room.inGame) {
        const socketIds = Array.from(room.players.keys())
        const idx = socketIds.indexOf(socket.id)
        if (idx >= 0 && idx < gs.players.length) {
          gs.players[idx].bankrupt = true
          io.to(room.code).emit('game-update', gs, [`💀 ${gs.players[idx].name} 断线离开`], null)

          const active = gs.players.filter(p => !p.bankrupt)
          if (active.length <= 1) {
            gs.gameOver = true
            gs.winner = active[0]?.id ?? null
            io.to(room.code).emit('game-over', gs)
            room.inGame = false
            roomGames.delete(room.code)
          }
        }
      }

      const { room: updatedRoom, dissolved } = leaveRoom(socket.id)
      if (!dissolved && updatedRoom) {
        socket.to(room.code).emit('room-update', serializeRoom(updatedRoom))
      }
    }
  })
}

function advancePlayer(gs: GameState, room: Room, io: Server, msgs: string[], socketIds: string[]) {
  const activePlayers = gs.players.filter(p => !p.bankrupt)
  if (activePlayers.length <= 1) {
    gs.gameOver = true
    gs.winner = activePlayers[0]?.id ?? null
    msgs.push(`🎉 游戏结束！${activePlayers[0]?.name} 获胜！`)
    io.to(room.code).emit('game-update', gs, msgs, null)
    io.to(room.code).emit('game-over', gs)
    room.inGame = false
    roomGames.delete(room.code)
    return
  }

  let next = (gs.currentPlayer + 1) % gs.players.length
  while (gs.players[next].bankrupt) next = (next + 1) % gs.players.length
  if (next <= gs.currentPlayer) gs.round++
  gs.currentPlayer = next
  gs.phase = 'roll'

  if (gs.round > gs.maxRounds) {
    gs.gameOver = true
    const richest = [...gs.players].filter(p => !p.bankrupt).sort((a, b) => totalWealth(b) - totalWealth(a))
    gs.winner = richest[0]?.id ?? null
    msgs.push(`⏰ ${gs.maxRounds}回合结束！${richest[0]?.name} 以总资产最高获胜！`)
    io.to(room.code).emit('game-update', gs, msgs, null)
    io.to(room.code).emit('game-over', gs)
    room.inGame = false
    roomGames.delete(room.code)
    return
  }

  io.to(room.code).emit('game-update', gs, msgs, null)
  io.to(socketIds[gs.currentPlayer]).emit('your-turn')
}
