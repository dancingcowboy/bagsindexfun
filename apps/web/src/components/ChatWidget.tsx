'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'

interface Message {
  id: string
  direction: 'user' | 'support'
  message: string
  createdAt: string
}

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [unread, setUnread] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const lastCountRef = useRef(0)

  const fetchMessages = useCallback(async () => {
    try {
      const res = await api.getChatMessages()
      const msgs: Message[] = res.data || []
      setMessages(msgs)

      const supportCount = msgs.filter((m) => m.direction === 'support').length
      if (!isOpen && supportCount > lastCountRef.current) {
        setUnread((prev) => prev + (supportCount - lastCountRef.current))
      }
      lastCountRef.current = supportCount
    } catch {
      // silent
    }
  }, [isOpen])

  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, isOpen ? 5000 : 15000)
    return () => clearInterval(interval)
  }, [isOpen, fetchMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleOpen = () => {
    setIsOpen(true)
    setUnread(0)
  }

  const handleSend = async () => {
    if (!input.trim() || sending) return
    const text = input.trim()
    setInput('')
    setSending(true)

    const optimistic: Message = {
      id: `temp-${Date.now()}`,
      direction: 'user',
      message: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])

    try {
      await api.sendChatMessage(text)
      await fetchMessages()
    } catch {
      // keep optimistic message
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <>
      {isOpen && (
        <div className="fixed bottom-20 right-6 z-50 w-[380px] max-h-[500px] flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgba(0,214,43,0.15)' }}>
                <svg className="w-4 h-4" style={{ color: '#00D62B' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--color-text-primary)]">Bags Support</p>
                <p className="text-xs" style={{ color: '#00D62B' }}>Usually replies within minutes</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] p-1"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-[200px] max-h-[340px]">
            {messages.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm text-[var(--color-text-muted)]">No messages yet.</p>
                <p className="text-xs mt-1 text-[var(--color-text-muted)]">Send us a message and we&apos;ll get back to you.</p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.direction === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.direction === 'user'
                      ? 'rounded-br-md'
                      : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] rounded-bl-md'
                  }`}
                  style={msg.direction === 'user' ? { backgroundColor: 'rgba(0,214,43,0.15)', color: '#b8ffca' } : undefined}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                  <p
                    className="text-[10px] mt-1"
                    style={{ color: msg.direction === 'user' ? 'rgba(0,214,43,0.4)' : 'var(--color-text-muted)' }}
                  >
                    {formatTime(msg.createdAt)}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                rows={1}
                className="flex-1 resize-none rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[#00D62B]/40 transition-colors"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="rounded-xl p-2.5 text-white disabled:opacity-30 transition-all"
                style={{ backgroundColor: '#00D62B' }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Bubble */}
      <button
        onClick={isOpen ? () => setIsOpen(false) : handleOpen}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full text-white shadow-lg transition-all flex items-center justify-center"
        style={{ backgroundColor: '#00D62B', boxShadow: '0 4px 20px rgba(0,214,43,0.25)' }}
      >
        {isOpen ? (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <>
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-[11px] font-bold flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </>
        )}
      </button>
    </>
  )
}
