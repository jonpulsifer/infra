'use client';

import { Clock, FileJson, Hash, Timer } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useIsMobile } from '@/hooks/use-mobile';
import type { WebhookFeed } from '@/hooks/use-webhook-feed';
import type { Webhook } from '@/lib/types';
import { WebhookDetail } from './webhook-detail';
import { WebhookDiffModal } from './webhook-diff-modal';
import { WebhookList } from './webhook-list';

/**
 * Renders a feed. Owns only presentation state - the layout split, which
 * detail tab is open, and the diff modal. The list, the selection, and the
 * polling belong to `useWebhookFeed`.
 */

const methodBadge = (method: string) => {
  const colors: Record<string, string> = {
    GET: 'bg-blue-500/15 text-blue-400',
    POST: 'bg-green-500/15 text-green-400',
    PUT: 'bg-yellow-500/15 text-yellow-400',
    PATCH: 'bg-orange-500/15 text-orange-400',
    DELETE: 'bg-red-500/15 text-red-400',
  };
  return colors[method] || 'bg-gray-500/15 text-gray-400';
};

type DetailTab = 'headers' | 'body' | 'response' | 'raw';

interface WebhookViewerProps {
  projectSlug: string;
  feed: WebhookFeed;
  onResend?: (webhook: Webhook) => void;
}

export function WebhookViewer({
  projectSlug,
  feed,
  onResend,
}: WebhookViewerProps) {
  const { webhooks, selected, select, clear, isLoading, isConnected } = feed;
  const isMobile = useIsMobile();
  const [detailTab, setDetailTab] = useState<DetailTab>('headers');
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [diffBaseId, setDiffBaseId] = useState<string | null>(null);
  const [diffCompareId, setDiffCompareId] = useState<string | null>(null);

  const handleSelect = useCallback(
    (webhook: Webhook) => {
      select(webhook);
      setDetailTab('headers');
    },
    [select],
  );

  const openDiff = useCallback(
    (base: Webhook, compare?: Webhook) => {
      setDiffBaseId(base.id);
      setDiffCompareId(
        (compare ?? webhooks.find((w) => w.id !== base.id))?.id ?? null,
      );
      setDiffModalOpen(true);
    },
    [webhooks],
  );

  const handleOpenDiffModal = useCallback(() => {
    if (selected) {
      openDiff(selected);
    }
  }, [selected, openDiff]);

  const handleCompare = useCallback(
    (webhook: Webhook) => {
      if (selected && webhook.id !== selected.id) {
        openDiff(selected, webhook);
      } else if (!selected) {
        openDiff(webhook);
      }
    },
    [selected, openDiff],
  );

  const handleClearHistory = useCallback(async () => {
    if (!confirm('Are you sure you want to clear all webhook history?')) {
      return;
    }
    try {
      await clear();
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  }, [clear]);

  const panelGroupId = useMemo(
    () => `webhook-viewer-panels-${projectSlug}`,
    [projectSlug],
  );

  if (isMobile) {
    return (
      <div className="rounded-lg border border-border/50 shadow-md bg-card flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="p-3 border-b border-border/50 flex items-center justify-between gap-2 bg-muted/20">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Webhooks</h2>
            <span
              className="text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {webhooks.length}
            </span>
          </div>
          {webhooks.length > 0 && (
            <button
              type="button"
              onClick={handleClearHistory}
              className="text-xs text-destructive hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {webhooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-2">
            <span className="text-sm text-muted-foreground">
              {isLoading
                ? 'Loading webhooks...'
                : 'No webhooks yet. Send one to see it here.'}
            </span>
          </div>
        ) : (
          <Accordion
            type="single"
            collapsible
            className="flex-1 overflow-auto"
            value={selected?.id}
            onValueChange={(id) => {
              const webhook = webhooks.find((w) => w.id === id);
              if (webhook) {
                handleSelect(webhook);
              }
            }}
          >
            {webhooks.map((webhook) => (
              <AccordionItem value={webhook.id} key={webhook.id}>
                <AccordionTrigger className="px-3 py-2 text-left hover:no-underline data-[state=open]:no-underline">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground w-full">
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-sm uppercase tracking-tight ${methodBadge(
                        webhook.method,
                      )}`}
                    >
                      {webhook.method}
                    </span>
                    <span className="text-[11px] uppercase">
                      {webhook.direction === 'incoming' ? 'IN' : 'OUT'}
                    </span>
                    {webhook.responseStatus !== undefined && (
                      <span
                        className={[
                          'text-[11px] px-2 py-0.5 rounded-sm border',
                          webhook.responseStatus >= 200 &&
                          webhook.responseStatus < 300
                            ? 'border-green-500/40 text-green-400 bg-green-500/10'
                            : webhook.responseStatus >= 400
                              ? 'border-red-500/40 text-red-400 bg-red-500/10'
                              : 'border-amber-500/40 text-amber-400 bg-amber-500/10',
                        ].join(' ')}
                      >
                        {webhook.responseStatus}
                      </span>
                    )}
                    {webhook.body && (
                      <span className="flex items-center gap-1">
                        <FileJson className="h-3 w-3 opacity-70" />
                        <span className="tabular-nums">
                          {new Blob([webhook.body]).size} B
                        </span>
                      </span>
                    )}
                    {webhook.duration !== undefined && (
                      <span className="flex items-center gap-1">
                        <Timer className="h-3 w-3 opacity-70" />
                        <span className="tabular-nums">
                          {webhook.duration}ms
                        </span>
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3 opacity-70" />
                      <span suppressHydrationWarning>
                        {new Date(webhook.timestamp).toLocaleDateString()}{' '}
                        {new Date(webhook.timestamp).toLocaleTimeString()}
                      </span>
                    </span>
                    <span className="flex items-center gap-1 font-mono text-foreground">
                      <Hash className="h-3 w-3 opacity-70" />
                      {webhook.id.slice(0, 8)}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-3">
                  <WebhookDetail webhook={webhook} onResend={onResend} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 shadow-md bg-card flex-1 overflow-hidden flex flex-col min-h-0">
      <Group
        id={panelGroupId}
        orientation="horizontal"
        className="h-full min-h-0"
      >
        <Panel
          id={`${panelGroupId}-list`}
          defaultSize={26}
          minSize={22}
          maxSize={34}
          className="min-h-0 overflow-hidden min-w-[220px] max-w-[360px]"
        >
          <WebhookList
            webhooks={webhooks}
            selectedWebhook={selected}
            onSelectWebhook={handleSelect}
            onClearHistory={handleClearHistory}
            isConnected={isConnected}
            projectSlug={projectSlug}
            onCompare={handleCompare}
            isLoading={isLoading}
          />
        </Panel>
        <Separator
          id={`${panelGroupId}-resize`}
          className="w-2 bg-border/50 hover:bg-primary/30 transition-colors"
        />
        <Panel
          id={`${panelGroupId}-detail`}
          defaultSize={70}
          minSize={50}
          className="min-h-0 overflow-hidden min-w-0"
        >
          {isLoading && !selected ? (
            <div className="flex flex-col items-center justify-center h-full py-16 px-4 bg-muted/20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4" />
              <p className="text-sm text-muted-foreground">
                Loading webhook details...
              </p>
            </div>
          ) : (
            <WebhookDetail
              webhook={selected}
              onResend={onResend}
              onOpenDiffModal={handleOpenDiffModal}
              activeTabExternal={detailTab}
              onActiveTabChange={setDetailTab}
            />
          )}
        </Panel>
      </Group>
      <WebhookDiffModal
        open={diffModalOpen}
        onOpenChange={setDiffModalOpen}
        webhooks={webhooks}
        initialBaseId={diffBaseId}
        initialCompareId={diffCompareId}
      />
    </div>
  );
}
