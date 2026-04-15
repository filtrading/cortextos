'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconRefresh } from '@tabler/icons-react';

interface Message {
  id: string;
  timestamp: string;
  agent: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

interface MessagesTabProps {
  agentName: string;
}

export function MessagesTab({ agentName }: MessagesTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'inbound' | 'outbound'>('all');

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/messages/history/${encodeURIComponent(agentName)}?limit=200`,
      );
      if (!res.ok) throw new Error('Failed to fetch');
      const data: Message[] = await res.json();
      setMessages(data);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const filtered = filter === 'all'
    ? messages
    : messages.filter(m => m.direction === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select
            value={filter}
            onValueChange={(v) => setFilter(v as typeof filter)}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="inbound">Inbound</SelectItem>
              <SelectItem value="outbound">Outbound</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            {filtered.length} message{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchMessages}
          disabled={loading}
        >
          <IconRefresh className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {loading ? 'Loading messages...' : 'No messages found.'}
        </div>
      ) : (
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {filtered.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg border p-3 text-sm ${
                msg.direction === 'outbound'
                  ? 'bg-primary/5 border-primary/20 ml-8'
                  : 'bg-muted/50 mr-8'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-xs">
                  {msg.direction === 'outbound' ? `${agentName} →` : `→ ${agentName}`}
                  {msg.source && (
                    <span className="text-muted-foreground ml-1">
                      ({msg.source})
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(msg.timestamp)}
                </span>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                {msg.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}
