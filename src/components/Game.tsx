'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  GameState, Player, Tile, BOARD, BOARD_SIZE, totalWealth,
} from '@/lib/game-engine'
import { BoardRenderer } from '@/lib/board-renderer'
import { connectSocket } from '@/lib/socket'
import {
  playDiceRoll, playDiceLand, playStepSound,
  playBuySound, playPaySound, playBankruptSound,
  setMuted, isMuted,
} from '@/lib/sound'

interface Props {
  initialGame: GameState
  myIndex: number
  onExit: () => void
}

export default function Game({ initialGame, myIndex, onExit }: Props) {
  const [game, setGame] = useState<GameState>(initialGame)
  const [messages, setMessages] = useState<string[]>(['🎲 游戏开始！'])
  const [isMyTurn, setIsMyTurn] = useState(initialGame.currentPlayer === myIndex)
  const [buyPrompt, setBuyPrompt] = useState<Tile | null>(null)
  const [highlightTile, setHighlightTile] = useState<number | undefined>()
  const [rolling, setRolling] = useState(false)
  const [diceResult, setDiceResult] = useState('')
  const [soundOn, setSoundOn] = useState(true)
  const [sellMode, setSellMode] = useState(false)
  const [tradeState, setTradeState] = useState<{
    step: 'selectPlayer' | 'selectTile' | 'setPrice'
    targetIdx?: number; tile?: Tile; offer?: number
  } | null>(null)
  const [incomingTrade, setIncomingTrade] = useState<{
    fromIdx: number; fromName: string; tileId: number; tileName: string; offer: number
  } | null>(null)
  const [auctionState, setAuctionState] = useState<{
    tile: Tile; highestBid: number; highestBidderId: number | null; passedPlayers: number[]
  } | null>(null)
  const [gameOver, setGameOver] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<BoardRenderer | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Canvas 初始化
  useEffect(() => {
    if (!canvasRef.current) return
    const r = new BoardRenderer(canvasRef.current)
    rendererRef.current = r
    r.resize()
    r.start()
    const onResize = () => r.resize()
    window.addEventListener('resize', onResize)
    return () => { r.stop(); window.removeEventListener('resize', onResize) }
  }, [])

  // 绘制
  useEffect(() => {
    if (!rendererRef.current) return
    rendererRef.current.setCurrentPlayer(game.currentPlayer)
    rendererRef.current.draw(game.players, highlightTile)
  }, [game, highlightTile])

  // 日志滚动
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [messages])

  // Socket 事件监听
  useEffect(() => {
    const socket = connectSocket()

    socket.on('game-update', (gs: GameState, msgs: string[], dice: [number, number] | null) => {
      if (dice) {
        const r = rendererRef.current
        playDiceRoll()
        r?.playDiceAnimation(dice, () => playDiceLand())

        const actingPlayer = gs.players[gs.currentPlayer] || gs.players[0]
        const total = dice[0] + dice[1]

        setTimeout(() => {
          if (r && actingPlayer) {
            const fromTile = (actingPlayer.position - total + BOARD_SIZE) % BOARD_SIZE
            r.playMoveAnimation(
              actingPlayer.id, fromTile, total, actingPlayer.color, actingPlayer.avatar,
              () => {
                setGame(gs)
                setHighlightTile(actingPlayer.position)
                if (msgs) setMessages(m => [...m, ...msgs])
                setDiceResult(`${dice[0]} + ${dice[1]} = ${total}`)
                triggerEffects(msgs, gs)
                setRolling(false)
              },
              () => playStepSound()
            )
          }
        }, 700)
      } else {
        setGame(gs)
        if (msgs) setMessages(m => [...m, ...msgs])
        triggerEffects(msgs, gs)
      }
    })

    socket.on('your-turn', () => {
      setIsMyTurn(true)
      setRolling(false)
    })

    socket.on('buy-prompt', (tile: Tile) => {
      setBuyPrompt(tile)
    })

    socket.on('auction-start', ({ tile, startBid, passedPlayers }: any) => {
      setAuctionState({ tile, highestBid: startBid, highestBidderId: null, passedPlayers })
    })

    socket.on('auction-update', ({ bidderId, amount }: { bidderId: number; amount: number }) => {
      setAuctionState(prev => prev ? { ...prev, highestBid: amount, highestBidderId: bidderId } : null)
      setMessages(m => [...m, `🔨 ${bidderId} 出价 ¥${amount}`])
    })

    socket.on('trade-request', (data: any) => {
      setIncomingTrade(data)
    })

    socket.on('game-over', (gs: GameState) => {
      setGame(gs)
      setGameOver(true)
    })

    return () => {
      socket.off('game-update')
      socket.off('your-turn')
      socket.off('buy-prompt')
      socket.off('auction-start')
      socket.off('auction-update')
      socket.off('trade-request')
      socket.off('game-over')
    }
  }, [myIndex])

  const triggerEffects = (msgs: string[], gs: GameState) => {
    const r = rendererRef.current
    if (!r) return
    for (const msg of msgs) {
      if (msg.includes('购买了') || msg.includes('拍得')) playBuySound()
      if (msg.includes('支付租金') || msg.includes('缴纳') || msg.includes('花费')) playPaySound()
      if (msg.includes('破产')) playBankruptSound()
    }
  }

  // 操作
  const handleRoll = () => {
    if (!isMyTurn || rolling || buyPrompt || auctionState) return
    setRolling(true)
    setIsMyTurn(false)
    setDiceResult('')
    connectSocket().emit('roll')
  }

  const handleBuy = (buy: boolean) => {
    if (!buyPrompt) return
    const socket = connectSocket()
    if (buy) {
      socket.emit('buy', { tileId: buyPrompt.id })
    } else {
      socket.emit('skip')
    }
    setBuyPrompt(null)
    setIsMyTurn(false)
  }

  const handleSell = (tileId: number) => {
    connectSocket().emit('sell-property', { tileId })
  }

  const handleTradeOffer = (targetIdx: number, tileId: number, offer: number) => {
    connectSocket().emit('trade-offer', { targetIdx, tileId, offer })
    setTradeState(null)
  }

  const handleTradeResponse = (accepted: boolean) => {
    if (!incomingTrade) return
    connectSocket().emit('trade-response', {
      accepted,
      fromIdx: incomingTrade.fromIdx,
      tileId: incomingTrade.tileId,
      offer: incomingTrade.offer,
    })
    setIncomingTrade(null)
  }

  const handleAuctionBid = (amount: number) => {
    connectSocket().emit('auction-bid', { amount })
    setAuctionState(prev => prev ? { ...prev, highestBid: amount, highestBidderId: myIndex, passedPlayers: [...prev.passedPlayers, myIndex] } : null)
  }

  const handleAuctionPass = () => {
    setAuctionState(prev => prev ? { ...prev, passedPlayers: [...prev.passedPlayers, myIndex] } : null)
  }

  const handleAuctionEnd = () => {
    if (!auctionState) return
    connectSocket().emit('auction-end', {
      winnerId: auctionState.highestBidderId,
      amount: auctionState.highestBid,
      tileId: auctionState.tile.id,
    })
    setAuctionState(null)
  }

  const currentPlayer = game.players[game.currentPlayer]
  const myPlayer = game.players[myIndex]

  return (
    <div className="h-screen w-screen flex">
      {/* 左侧：棋盘 */}
      <div className="flex-1 flex items-center justify-center bg-[#0f1419] p-4 relative">
        <canvas ref={canvasRef} className="max-w-full max-h-full" />

        {/* 音效开关 */}
        <button onClick={() => { const next = !soundOn; setSoundOn(next); setMuted(!next) }}
          className="absolute top-3 left-3 z-10 w-9 h-9 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-lg hover:bg-black/60 transition-colors backdrop-blur-sm">
          {soundOn ? '🔊' : '🔇'}
        </button>

        {/* 我的信息标签 */}
        <div className="absolute bottom-3 left-3 z-10 bg-black/50 backdrop-blur-sm rounded-xl px-3 py-2 border border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-lg">{myPlayer?.avatar}</span>
            <span className="text-white text-sm font-bold">{myPlayer?.name}</span>
            <span className="text-amber-400 text-sm font-bold">¥{myPlayer?.money}</span>
          </div>
        </div>

        {/* 游戏结束 */}
        {gameOver && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10 text-center">
              <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-400 mb-2">
                🎉 游戏结束
              </h2>
              <p className="text-white text-xl font-bold mb-6">
                {game.players.find(p => p.id === game.winner)?.name} 获胜！
              </p>
              <div className="space-y-3 mb-6">
                {[...game.players].sort((a, b) => totalWealth(b) - totalWealth(a)).map((p, i) => (
                  <div key={p.id} className="flex items-center justify-between p-3 rounded-lg"
                    style={{ background: p.color + '15', border: `1px solid ${p.color}33` }}>
                    <div className="flex items-center gap-2">
                      <span>{i === 0 ? '👑' : ''} {p.avatar}</span>
                      <span className="text-white font-medium">{p.name}</span>
                      {p.bankrupt && <span className="text-xs text-red-400">破产</span>}
                    </div>
                    <span className="text-amber-400 font-bold">¥{totalWealth(p)}</span>
                  </div>
                ))}
              </div>
              <button onClick={onExit}
                className="px-8 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold">
                返回大厅
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右侧：信息面板 */}
      <div className="w-80 bg-[#1a2332] border-l border-white/10 flex flex-col h-screen overflow-hidden">
        {/* 当前回合 */}
        <div className="p-4 border-b border-white/10 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1" style={{ background: currentPlayer?.color }} />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl"
                style={{ background: currentPlayer?.color + '33', border: `2px solid ${currentPlayer?.color}` }}>
                {currentPlayer?.avatar}
              </div>
              <div>
                <div className="text-white font-bold">{currentPlayer?.name}的回合</div>
                <div className="text-gray-500 text-xs">第{game.round}回合</div>
              </div>
            </div>
            {isMyTurn && <span className="text-xs px-2 py-1 rounded-full bg-green-500/20 text-green-400 font-bold animate-pulse">你的回合</span>}
          </div>
        </div>

        {/* 玩家列表 */}
        <div className="p-3 border-b border-white/10 space-y-1.5">
          {game.players.map((p, i) => (
            <div key={p.id} className={`flex items-center justify-between p-2 rounded-lg ${p.bankrupt ? 'opacity-30' : ''}`}
              style={{ background: i === game.currentPlayer ? p.color + '15' : 'transparent', border: i === game.currentPlayer ? `1px solid ${p.color}33` : '1px solid transparent' }}>
              <div className="flex items-center gap-2">
                <span>{p.avatar}</span>
                <span className="text-sm text-white">{p.name}</span>
                {i === myIndex && <span className="text-[10px] text-blue-400">(你)</span>}
              </div>
              <div className="text-right">
                <div className="text-xs font-bold" style={{ color: p.color }}>¥{p.money}</div>
                <div className="text-[10px] text-gray-500">{p.properties.length}块地</div>
              </div>
            </div>
          ))}
        </div>

        {/* 操作区 */}
        <div className="p-4 border-b border-white/10">
          {diceResult && <div className="text-center text-sm text-amber-400 font-bold mb-2">🎲 {diceResult}</div>}

          {/* 收到交易请求 */}
          {incomingTrade ? (
            <div className="bounce-in space-y-2">
              <div className="text-white font-bold text-sm">🤝 收到交易请求</div>
              <div className="text-xs text-gray-400">{incomingTrade.fromName} 想以 ¥{incomingTrade.offer} 购买你的 {incomingTrade.tileName}</div>
              <div className="flex gap-2">
                <button onClick={() => handleTradeResponse(true)} className="flex-1 py-2 bg-green-600 rounded-lg text-white text-xs font-bold">接受</button>
                <button onClick={() => handleTradeResponse(false)} className="flex-1 py-2 bg-red-600/80 rounded-lg text-white text-xs font-bold">拒绝</button>
              </div>
            </div>
          ) : auctionState && !auctionState.passedPlayers.includes(myIndex) ? (
            <div className="bounce-in space-y-2">
              <div className="text-white font-bold text-sm">🔨 拍卖: {auctionState.tile.name}</div>
              <div className="text-xs text-gray-400">当前最高 <span className="text-amber-400 font-bold">¥{auctionState.highestBid}</span></div>
              <div className="flex gap-2">
                <button onClick={() => handleAuctionBid(auctionState.highestBid + 20)}
                  disabled={auctionState.highestBid + 20 > (myPlayer?.money || 0)}
                  className="flex-1 py-2 bg-amber-600 rounded-lg text-white text-xs font-bold disabled:opacity-40">
                  +¥20
                </button>
                <button onClick={() => handleAuctionBid(auctionState.highestBid + 50)}
                  disabled={auctionState.highestBid + 50 > (myPlayer?.money || 0)}
                  className="flex-1 py-2 bg-amber-600 rounded-lg text-white text-xs font-bold disabled:opacity-40">
                  +¥50
                </button>
              </div>
              <button onClick={handleAuctionPass} className="w-full py-2 bg-white/10 rounded-lg text-gray-300 text-xs">放弃</button>
            </div>
          ) : auctionState ? (
            <div className="bounce-in">
              <div className="text-xs text-gray-400 mb-2">拍卖进行中... 最高 ¥{auctionState.highestBid}</div>
              {game.currentPlayer === myIndex && (
                <button onClick={handleAuctionEnd} className="w-full py-2 bg-green-600 rounded-lg text-white text-xs font-bold">确认结果</button>
              )}
            </div>
          ) : buyPrompt ? (
            <div className="bounce-in">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">{buyPrompt.emoji}</span>
                <span className="text-white font-bold">{buyPrompt.name}</span>
              </div>
              <div className="text-xs text-gray-400 mb-3">价格 ¥{buyPrompt.price} · 租金 ¥{buyPrompt.rent[0]}</div>
              <div className="flex gap-2">
                <button onClick={() => handleBuy(true)} className="flex-1 py-2.5 bg-green-600 rounded-lg text-white text-sm font-bold">💰 购买</button>
                <button onClick={() => handleBuy(false)} className="flex-1 py-2.5 bg-white/10 rounded-lg text-gray-300 text-sm">跳过</button>
              </div>
            </div>
          ) : sellMode && myPlayer ? (
            <div className="bounce-in">
              <div className="flex items-center justify-between mb-2">
                <span className="text-white font-bold text-sm">变卖资产（6折）</span>
                <button onClick={() => setSellMode(false)} className="text-xs text-gray-400 hover:text-white">返回</button>
              </div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {myPlayer.properties.map(id => {
                  const tile = BOARD[id]
                  return (
                    <div key={id} className="flex items-center justify-between p-2 rounded-lg bg-white/5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: tile.color }} />
                        <span className="text-xs text-white">{tile.name}</span>
                      </div>
                      <button onClick={() => handleSell(id)}
                        className="text-xs px-2.5 py-1 rounded-md bg-amber-600/80 text-white font-medium">
                        卖 ¥{Math.floor(tile.price * 0.6)}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : tradeState ? (
            <div className="bounce-in">
              <div className="flex items-center justify-between mb-2">
                <span className="text-white font-bold text-sm">🤝 交易</span>
                <button onClick={() => setTradeState(null)} className="text-xs text-gray-400 hover:text-white">取消</button>
              </div>
              {tradeState.step === 'selectPlayer' && (
                <div className="space-y-1.5">
                  {game.players.filter((p, i) => i !== myIndex && !p.bankrupt && p.properties.length > 0).map((p, _, __, i = game.players.indexOf(p)) => (
                    <button key={p.id} onClick={() => setTradeState({ step: 'selectTile', targetIdx: game.players.indexOf(p) })}
                      className="w-full flex items-center gap-2 p-2 rounded-lg bg-white/5 hover:bg-white/10 text-left">
                      <span>{p.avatar}</span>
                      <span className="text-xs text-white">{p.name}</span>
                      <span className="text-xs text-gray-500 ml-auto">{p.properties.length}块地</span>
                    </button>
                  ))}
                </div>
              )}
              {tradeState.step === 'selectTile' && tradeState.targetIdx !== undefined && (
                <div className="space-y-1.5">
                  {game.players[tradeState.targetIdx].properties.map(id => {
                    const tile = BOARD[id]
                    return (
                      <button key={id} onClick={() => setTradeState({ ...tradeState, step: 'setPrice', tile })}
                        className="w-full flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10">
                        <span className="text-xs text-white">{tile.name}</span>
                        <span className="text-xs text-gray-400">¥{tile.price}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {tradeState.step === 'setPrice' && tradeState.tile && tradeState.targetIdx !== undefined && (
                <div className="space-y-2">
                  <div className="text-xs text-gray-400">出价购买 {tradeState.tile.name}</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[1.0, 1.3, 1.5].map(mult => {
                      const price = Math.floor(tradeState.tile!.price * mult)
                      return (
                        <button key={mult} onClick={() => handleTradeOffer(tradeState.targetIdx!, tradeState.tile!.id, price)}
                          disabled={price > (myPlayer?.money || 0)}
                          className="py-2 rounded-lg bg-blue-600/80 text-white text-xs font-medium disabled:opacity-40">
                          ¥{price}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : isMyTurn && !rolling ? (
            <div className="space-y-2">
              <button onClick={handleRoll}
                className="w-full py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold text-lg active:scale-95 transition-all">
                🎲 掷骰子
              </button>
              {myPlayer && myPlayer.properties.length > 0 && (
                <button onClick={() => setSellMode(true)}
                  className="w-full py-2 rounded-lg border border-amber-500/30 text-amber-400 text-xs font-medium">
                  🏷️ 变卖资产
                </button>
              )}
              {game.players.some((p, i) => i !== myIndex && !p.bankrupt && p.properties.length > 0) && (
                <button onClick={() => setTradeState({ step: 'selectPlayer' })}
                  className="w-full py-2 rounded-lg border border-blue-500/30 text-blue-400 text-xs font-medium">
                  🤝 发起交易
                </button>
              )}
            </div>
          ) : (
            <div className="text-center text-gray-500 py-3 animate-pulse">
              {rolling ? '🎲 骰子翻滚中...' : `⏳ 等待 ${currentPlayer?.name} 操作...`}
            </div>
          )}
        </div>

        {/* 日志 */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="px-4 pt-3 text-xs text-gray-500 font-medium">游戏日志</div>
          <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-1.5">
            {messages.map((msg, i) => (
              <div key={i} className={`text-xs ${i === messages.length - 1 ? 'text-white font-medium fade-in' : 'text-gray-500'}`}>
                {msg}
              </div>
            ))}
          </div>
        </div>

        {/* 地皮归属 */}
        <div className="p-3 border-t border-white/10 max-h-36 overflow-y-auto">
          <div className="text-xs text-gray-500 mb-2">地皮归属</div>
          {game.players.filter(p => p.properties.length > 0).map(p => (
            <div key={p.id} className="mb-1.5">
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-xs">{p.avatar}</span>
                <span className="text-xs font-medium" style={{ color: p.color }}>{p.name}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {p.properties.map(id => (
                  <span key={id} className="text-xs px-1.5 py-0.5 rounded text-white" style={{ background: BOARD[id].color + '99' }}>
                    {BOARD[id].name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
